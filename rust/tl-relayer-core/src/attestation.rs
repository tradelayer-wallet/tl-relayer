//! IP reputation attestation.
//!
//! Port of `attestation.service.ts` and the client-IP extraction of
//! `attestation.route.ts`. Provider calls are the [`IpIntel`] trait; the cache
//! is bounded and clock-driven; the IP is parsed strictly before it can reach
//! any provider URL; forwarding headers are honoured only when the deployment
//! says a trusted proxy sets them.

use crate::error::{Error, Result};
use crate::ports::{Clock, IpIntel};
use serde_json::Value;
use std::collections::BTreeMap;
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailurePolicy {
    /// Legacy: unreachable providers yield `isBlocked: false`.
    Open,
    /// Unreachable providers block.
    Closed,
}

#[derive(Debug, Clone)]
pub struct AttestationConfig {
    pub banned_countries: Vec<String>,
    pub cache_ttl_ms: u64,
    pub failure_cache_ttl_ms: u64,
    pub max_cache_entries: usize,
    pub failure_policy: FailurePolicy,
}

impl Default for AttestationConfig {
    fn default() -> Self {
        AttestationConfig {
            banned_countries: ["US", "KP", "SD", "RU", "IR"].map(String::from).to_vec(),
            cache_ttl_ms: 60 * 60 * 1000,
            failure_cache_ttl_ms: 60 * 1000,
            max_cache_entries: 10_000,
            failure_policy: FailurePolicy::Open,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpAttestation {
    pub success: bool,
    pub ip: String,
    pub country_code: Option<String>,
    pub is_vpn: Option<bool>,
    pub is_proxy: Option<bool>,
    pub is_darkweb: Option<bool>,
    pub is_anonymous_vpn: Option<bool>,
    pub is_blocked: bool,
    pub source: &'static str,
    pub message: String,
    pub error: Option<String>,
}

struct IpInfoLookup {
    ip: String,
    country: String,
    vpn: bool,
    proxy: bool,
}

struct CriminalIpLookup {
    country: String,
    vpn: bool,
    proxy: bool,
    darkweb: bool,
    anonymous_vpn: bool,
}

/// `normalizeIp` plus strict parsing: strips an IPv4-mapped prefix and rejects
/// anything that is not an IP literal (so it can never smuggle path or query
/// characters into a provider URL).
pub fn normalize_ip(raw: &str) -> Result<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 45 {
        return Err(Error::InvalidField("ip"));
    }
    let ip: IpAddr = t.parse().map_err(|_| Error::InvalidField("ip"))?;
    Ok(ip.to_canonical().to_string())
}

/// Two ASCII letters, uppercased; anything else is `UNKNOWN`.
pub fn normalize_country(v: Option<&Value>) -> String {
    let s = v
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_uppercase();
    if s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase()) {
        s
    } else {
        "UNKNOWN".into()
    }
}

/// Port of `countryFromCriminalIpData` (`attestation.service.ts:184`).
pub fn country_from_criminalip(data: &Value) -> String {
    let direct = [
        data.get("country_code"),
        data.get("country"),
        data.get("ip_country_code"),
        data.get("location").and_then(|l| l.get("country_code")),
        data.get("location").and_then(|l| l.get("country")),
        data.get("summary").and_then(|l| l.get("country_code")),
        data.get("summary").and_then(|l| l.get("country")),
    ];
    for c in direct.into_iter().flatten() {
        if c.as_str().is_some_and(|s| !s.is_empty()) {
            return normalize_country(Some(c));
        }
    }
    if let Some(entries) = data
        .get("whois")
        .and_then(|w| w.get("data"))
        .and_then(Value::as_array)
    {
        for e in entries {
            for k in [
                "org_country_code",
                "country_code",
                "country",
                "registry_country_code",
            ] {
                if let Some(c) = e
                    .get(k)
                    .filter(|c| c.as_str().is_some_and(|s| !s.is_empty()))
                {
                    return normalize_country(Some(c));
                }
            }
        }
    }
    "UNKNOWN".into()
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn parse_ipinfo(ip: &str, data: &Value) -> Option<IpInfoLookup> {
    if !data.is_object() {
        return None;
    }
    let privacy = data.get("privacy");
    let g = |k: &str| privacy.and_then(|p| p.get(k));
    let country = if truthy(data.get("country")) {
        data.get("country")
    } else {
        data.get("country_code")
    };
    let reported_ip = data
        .get("ip")
        .and_then(Value::as_str)
        .and_then(|s| normalize_ip(s).ok())
        .unwrap_or_else(|| ip.to_string());
    Some(IpInfoLookup {
        ip: reported_ip,
        country: normalize_country(country),
        vpn: truthy(g("vpn")),
        proxy: truthy(g("proxy")),
    })
}

fn parse_criminalip(data: &Value) -> Option<CriminalIpLookup> {
    if !data.is_object() {
        return None;
    }
    let issues = data.get("issues");
    let g = |k: &str| issues.and_then(|p| p.get(k));
    Some(CriminalIpLookup {
        country: country_from_criminalip(data),
        vpn: truthy(g("is_vpn")),
        proxy: truthy(g("is_proxy")),
        darkweb: truthy(g("is_darkweb")),
        anonymous_vpn: truthy(g("is_anonymous_vpn")),
    })
}

pub struct AttestationService<I: IpIntel, C: Clock> {
    cfg: AttestationConfig,
    intel: I,
    clock: C,
    cache: BTreeMap<String, (u64, IpAttestation)>,
}

impl<I: IpIntel, C: Clock> AttestationService<I, C> {
    pub fn new(cfg: AttestationConfig, intel: I, clock: C) -> Self {
        AttestationService {
            cfg,
            intel,
            clock,
            cache: BTreeMap::new(),
        }
    }

    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }

    pub fn check_ip(&mut self, raw: &str) -> Result<IpAttestation> {
        let ip = normalize_ip(raw)?;
        let now = self.clock.now_ms();
        if let Some((exp, r)) = self.cache.get(&ip) {
            if *exp > now {
                return Ok(r.clone());
            }
        }
        self.cache.remove(&ip);
        let r = self.check_uncached(&ip);
        let ttl = if r.success {
            self.cfg.cache_ttl_ms
        } else {
            self.cfg.failure_cache_ttl_ms
        };
        if ttl > 0 {
            self.insert(ip, now.saturating_add(ttl), r.clone());
        }
        Ok(r)
    }

    fn insert(&mut self, ip: String, expires: u64, r: IpAttestation) {
        let now = self.clock.now_ms();
        if self.cache.len() >= self.cfg.max_cache_entries {
            self.cache.retain(|_, (e, _)| *e > now);
        }
        if self.cache.len() >= self.cfg.max_cache_entries {
            if let Some(oldest) = self
                .cache
                .iter()
                .min_by_key(|(_, (e, _))| *e)
                .map(|(k, _)| k.clone())
            {
                self.cache.remove(&oldest);
            }
        }
        self.cache.insert(ip, (expires, r));
    }

    fn check_uncached(&mut self, ip: &str) -> IpAttestation {
        let info = self
            .intel
            .ipinfo(ip)
            .ok()
            .and_then(|v| parse_ipinfo(ip, &v));
        let crim = self
            .intel
            .criminalip(ip)
            .ok()
            .flatten()
            .and_then(|v| parse_criminalip(&v));
        if info.is_none() && crim.is_none() {
            let blocked = self.cfg.failure_policy == FailurePolicy::Closed;
            return IpAttestation {
                success: false,
                ip: ip.to_string(),
                country_code: None,
                is_vpn: None,
                is_proxy: None,
                is_darkweb: None,
                is_anonymous_vpn: None,
                is_blocked: blocked,
                source: "unknown",
                message: "No IP reputation provider succeeded".into(),
                error: Some(
                    "Both primary and fallback IP reputation APIs failed or are not configured."
                        .into(),
                ),
            };
        }
        let mut country = [
            info.as_ref().map(|i| i.country.as_str()),
            crim.as_ref().map(|c| c.country.as_str()),
        ]
        .into_iter()
        .flatten()
        .find(|c| *c != "UNKNOWN")
        .unwrap_or("UNKNOWN")
        .to_string();
        if country == "UNKNOWN" {
            if let Ok(v) = self.intel.ip_api(ip) {
                let ok = v
                    .get("status")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s == "success");
                if ok {
                    let c = normalize_country(v.get("countryCode"));
                    if c != "UNKNOWN" {
                        country = c;
                    }
                }
            }
        }
        let vpn = info.as_ref().is_some_and(|i| i.vpn) || crim.as_ref().is_some_and(|c| c.vpn);
        let proxy =
            info.as_ref().is_some_and(|i| i.proxy) || crim.as_ref().is_some_and(|c| c.proxy);
        let darkweb = crim.as_ref().is_some_and(|c| c.darkweb);
        let anon = crim.as_ref().is_some_and(|c| c.anonymous_vpn);
        let banned = self.cfg.banned_countries.contains(&country);
        let blocked = vpn || proxy || darkweb || anon || banned;
        IpAttestation {
            success: true,
            ip: info
                .as_ref()
                .map_or_else(|| ip.to_string(), |i| i.ip.clone()),
            country_code: Some(country),
            is_vpn: Some(vpn),
            is_proxy: Some(proxy),
            is_darkweb: Some(darkweb),
            is_anonymous_vpn: Some(anon),
            is_blocked: blocked,
            source: match (info.is_some(), crim.is_some()) {
                (true, true) => "ipinfo+criminalip",
                (true, false) => "ipinfo",
                _ => "criminalip",
            },
            message: if blocked {
                "Suspicious IP detected or originating from a banned country.".into()
            } else {
                "IP is clean and trusted.".into()
            },
            error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIpPolicy {
    /// A trusted reverse proxy sets the forwarding headers.
    pub trust_proxy_headers: bool,
    /// Number of trusted proxy hops appending to `x-forwarded-for`.
    pub xff_trusted_hops: usize,
    /// `ATTESTATION_ALLOW_IP_OVERRIDE`: the body may name the IP to check.
    pub allow_body_override: bool,
}

impl Default for ClientIpPolicy {
    fn default() -> Self {
        ClientIpPolicy {
            trust_proxy_headers: false,
            xff_trusted_hops: 1,
            allow_body_override: false,
        }
    }
}

/// Resolve the IP to attest. `headers` must be lower-cased names. Without
/// `trust_proxy_headers` the transport peer address is used and every header is
/// ignored (any client can set `X-Forwarded-For`).
pub fn client_ip(
    policy: &ClientIpPolicy,
    peer: &str,
    headers: &BTreeMap<String, String>,
    body_ip: Option<&str>,
) -> Option<String> {
    if policy.allow_body_override {
        if let Some(ip) = body_ip.and_then(|b| normalize_ip(b).ok()) {
            return Some(ip);
        }
    }
    if policy.trust_proxy_headers {
        for h in ["cf-connecting-ip", "x-real-ip"] {
            if let Some(ip) = headers.get(h).and_then(|v| normalize_ip(v).ok()) {
                return Some(ip);
            }
        }
        if let Some(x) = headers.get("x-forwarded-for") {
            let parts: Vec<&str> = x.split(',').map(str::trim).collect();
            let hops = policy.xff_trusted_hops.max(1);
            if parts.len() >= hops {
                if let Ok(ip) = normalize_ip(parts[parts.len() - hops]) {
                    return Some(ip);
                }
            }
        }
    }
    normalize_ip(peer).ok()
}
