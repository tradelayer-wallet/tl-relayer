// src/services/attestation.service.ts
import axios, { AxiosResponse } from 'axios';
import { isIP } from 'net';
import { envConfig } from '../config/env.config';

// Issue #1 round 2 / NEW-5: the single outbound path for reputation providers.
// axios's own `timeout` only bounds socket inactivity, so a stalled DNS lookup
// or a slow-drip body can outlive it. The AbortController enforces a wall-clock
// deadline over the whole request. Failures reject, as with plain axios.
const providerGet = async (url: string, headers?: Record<string, string>): Promise<AxiosResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), envConfig.ATTESTATION_PROVIDER_TIMEOUT_MS);
  try {
    return await axios.get(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export interface IpAttestationResult {
  success: boolean;
  ip: string;
  countryCode?: string;
  isVpn?: boolean;
  isProxy?: boolean;
  isDarkweb?: boolean;
  isAnonymousVpn?: boolean;
  isBlocked: boolean;
  source: 'criminalip' | 'ipinfo' | 'ipinfo+criminalip' | 'unknown';
  message?: string;
  error?: string;
  attestation?: {
    ip: string;
    country?: string;
    countryCode?: string;
    isVpn?: boolean;
    isProxy?: boolean;
    isDarkweb?: boolean;
    isAnonymousVpn?: boolean;
    isBlocked?: boolean;
    message?: string;
    source?: string;
  };
}

type CachedIpAttestation = {
  expiresAt: number;
  result: IpAttestationResult;
};

type IpInfoLookup = {
  ip: string;
  countryCode: string;
  isVpn: boolean;
  isProxy: boolean;
};

type CriminalIpLookup = {
  countryCode: string;
  isVpn: boolean;
  isProxy: boolean;
  isDarkweb: boolean;
  isAnonymousVpn: boolean;
};

export class AttestationService {
  private readonly CRIMINAL_IP_API_KEY =
    process.env.CRIMINAL_IP_API_KEY || process.env.VPN_CRIMINALIP || '';
  private readonly IPINFO_TOKEN =
    process.env.IPINFO_TOKEN || process.env.VPN_IPINFO || '';

  private readonly bannedCountries = ['US', 'KP', 'SD', 'RU', 'IR'];
  private readonly cacheTtlMs = Number(process.env.ATTESTATION_CACHE_TTL_MS || 60 * 60 * 1000);
  private readonly failureCacheTtlMs = Number(process.env.ATTESTATION_FAILURE_CACHE_TTL_MS || 60 * 1000);
  private readonly cache = new Map<string, CachedIpAttestation>();

  async checkIp(ipAddress: string): Promise<IpAttestationResult> {
    const normalizedIp = this.normalizeIp(ipAddress);
    // Issue #1 / H3: only well-formed IP addresses may be interpolated into
    // outbound provider URLs; anything else is rejected before any call is made.
    if (!isIP(normalizedIp)) {
      return this.withLegacyAttestation({
        success: false,
        ip: normalizedIp,
        isBlocked: false,
        source: 'unknown',
        message: 'Invalid IP address',
        error: 'Invalid IP address',
      });
    }
    const cached = this.getCached(normalizedIp);
    if (cached) return cached;

    const result = await this.checkIpUncached(normalizedIp);
    this.setCached(normalizedIp, result);
    return result;
  }

  private async checkIpUncached(ipAddress: string): Promise<IpAttestationResult> {
    const [ipInfo, criminalIp] = await Promise.all([
      this.lookupIpInfo(ipAddress),
      this.lookupCriminalIp(ipAddress),
    ]);

    if (ipInfo || criminalIp) {
      const countryCode = await this.resolveCountryCode(
        ipAddress,
        ipInfo?.countryCode || criminalIp?.countryCode || 'UNKNOWN',
      );
      const isVpn = !!(ipInfo?.isVpn || criminalIp?.isVpn);
      const isProxy = !!(ipInfo?.isProxy || criminalIp?.isProxy);
      const isDarkweb = !!criminalIp?.isDarkweb;
      const isAnonymousVpn = !!criminalIp?.isAnonymousVpn;
      const fromBannedCountry = this.bannedCountries.includes(countryCode);
      const isBlocked =
        isVpn || isProxy || isDarkweb || isAnonymousVpn || fromBannedCountry;
      const source = ipInfo && criminalIp
        ? 'ipinfo+criminalip'
        : ipInfo
          ? 'ipinfo'
          : 'criminalip';

      return this.withLegacyAttestation({
        success: true,
        ip: ipInfo?.ip || ipAddress,
        countryCode,
        isVpn,
        isProxy,
        isDarkweb,
        isAnonymousVpn,
        isBlocked,
        source,
        message: isBlocked
          ? 'Suspicious IP detected or originating from a banned country.'
          : 'IP is clean and trusted.',
      });
    }

    return this.withLegacyAttestation({
      success: false,
      ip: ipAddress,
      isBlocked: false,
      source: 'unknown',
      message: 'No IP reputation provider succeeded',
      error:
        'Both primary and fallback IP reputation APIs failed or are not configured.',
    });
  }

  private async lookupIpInfo(ipAddress: string): Promise<IpInfoLookup | null> {
    // Issue #1 / H3: never interpolate an unvalidated IP into the outbound URL.
    if (!isIP(this.normalizeIp(ipAddress))) return null;
    try {
      const tokenQuery = this.IPINFO_TOKEN ? `?token=${this.IPINFO_TOKEN}` : '';
      const url = `https://ipinfo.io/${ipAddress}/json${tokenQuery}`;
      const resp = await providerGet(url);
      if (resp.status !== 200 || !resp.data) return null;

      const data = resp.data as any;
      const privacy = data.privacy || {};
      return {
        ip: data.ip || ipAddress,
        countryCode: this.normalizeCountryCode(data.country || data.country_code),
        isVpn: !!privacy.vpn,
        isProxy: !!privacy.proxy,
      };
    } catch (err: any) {
      console.error('[attestation] ipinfo failed:', err?.message || err);
      return null;
    }
  }

  private async lookupCriminalIp(ipAddress: string): Promise<CriminalIpLookup | null> {
    if (!this.CRIMINAL_IP_API_KEY) return null;
    // Issue #1 / H3: never interpolate an unvalidated IP into the outbound URL.
    if (!isIP(this.normalizeIp(ipAddress))) return null;

    try {
      const primaryUrl =
        `https://api.criminalip.io/v1/asset/ip/report?ip=${ipAddress}`;
      const response = await providerGet(primaryUrl, {
        'x-api-key': this.CRIMINAL_IP_API_KEY,
      });

      if (response.status !== 200 || !response.data) return null;

      const data = response.data as any;
      const issues = data.issues || {};
      const whois = data.whois || {};
      const whoisData: any[] = whois.data || [];
      return {
        countryCode: this.countryFromCriminalIpData(data, whoisData),
        isVpn: !!issues.is_vpn,
        isProxy: !!issues.is_proxy,
        isDarkweb: !!issues.is_darkweb,
        isAnonymousVpn: !!issues.is_anonymous_vpn,
      };
    } catch (err: any) {
      console.error('[attestation] CriminalIP failed:', err?.message || err);
      return null;
    }
  }

  private normalizeIp(ipAddress: string): string {
    return String(ipAddress || '').trim().replace(/^::ffff:/, '');
  }

  private normalizeCountryCode(countryCode: any): string {
    const normalized = String(countryCode || '').trim().toUpperCase();
    return normalized || 'UNKNOWN';
  }

  private countryFromCriminalIpData(data: any, whoisData: any[]): string {
    const directCountry =
      data?.country_code ||
      data?.country ||
      data?.ip_country_code ||
      data?.location?.country_code ||
      data?.location?.country ||
      data?.summary?.country_code ||
      data?.summary?.country;

    if (directCountry) return this.normalizeCountryCode(directCountry);

    for (const entry of whoisData || []) {
      const country =
        entry?.org_country_code ||
        entry?.country_code ||
        entry?.country ||
        entry?.registry_country_code;
      if (country) return this.normalizeCountryCode(country);
    }

    return 'UNKNOWN';
  }

  private async resolveCountryCode(ipAddress: string, providerCountryCode: string): Promise<string> {
    const normalized = this.normalizeCountryCode(providerCountryCode);
    if (normalized !== 'UNKNOWN') return normalized;

    const ipApiCountryCode = await this.lookupIpApiCountryCode(ipAddress);
    return ipApiCountryCode || normalized;
  }

  private async lookupIpApiCountryCode(ipAddress: string): Promise<string | null> {
    // Issue #1 / H3: never interpolate an unvalidated IP into the outbound URL.
    if (!isIP(this.normalizeIp(ipAddress))) return null;
    try {
      const url = `http://ip-api.com/json/${ipAddress}?fields=status,countryCode,message`;
      const resp = await providerGet(url);
      if (resp.status !== 200 || !resp.data) return null;
      const data = resp.data as any;
      if (data.status && data.status !== 'success') return null;

      const countryCode = this.normalizeCountryCode(data.countryCode);
      return countryCode === 'UNKNOWN' ? null : countryCode;
    } catch (err: any) {
      console.error('[attestation] ip-api country enrichment failed:', err?.message || err);
      return null;
    }
  }

  private getCached(ipAddress: string): IpAttestationResult | null {
    const cached = this.cache.get(ipAddress);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(ipAddress);
      return null;
    }
    return {
      ...cached.result,
      message: cached.result.message,
    };
  }

  private setCached(ipAddress: string, result: IpAttestationResult): void {
    const ttl = result.success ? this.cacheTtlMs : this.failureCacheTtlMs;
    if (ttl <= 0) return;
    this.cache.set(ipAddress, {
      expiresAt: Date.now() + ttl,
      result,
    });
  }

  private withLegacyAttestation(result: IpAttestationResult): IpAttestationResult {
    return {
      ...result,
      attestation: {
        ip: result.ip,
        country: result.countryCode,
        countryCode: result.countryCode,
        isVpn: result.isVpn,
        isProxy: result.isProxy,
        isDarkweb: result.isDarkweb,
        isAnonymousVpn: result.isAnonymousVpn,
        isBlocked: result.isBlocked,
        message: result.message,
        source: result.source,
      },
    };
  }
}
