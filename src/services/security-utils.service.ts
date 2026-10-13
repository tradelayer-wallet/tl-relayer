import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

/**
 * Lightweight security helpers (issue #1 hardening batch):
 * - constant-time secret comparison for optional API-key gates
 * - SSRF guard for operator-configured bootstrap seed URLs
 * - per-process internal auth marker for the in-process WS relay
 */

export const secureCompare = (provided: string, expected: string): boolean => {
    const a = createHash('sha256').update(String(provided || '')).digest();
    const b = createHash('sha256').update(String(expected || '')).digest();
    return timingSafeEqual(a, b) && String(provided || '') === String(expected || '');
};

/**
 * Issue #1 / M2: the WS relay forwards requests into the Fastify instance via
 * app.inject, so it must be able to satisfy the x-api-key gate without ever
 * handling the client's key per request. The relay validates the client key
 * once at WS handshake, then presents this per-process random marker on the
 * internal inject path. It is never logged, never echoed to clients, and is
 * stripped from client-supplied headers in ws-relay.service.ts, so external
 * callers cannot forge it.
 */
export const INTERNAL_RELAY_AUTH_HEADER = 'x-internal-relay-auth';
export const INTERNAL_RELAY_AUTH_TOKEN = randomBytes(32).toString('hex');

export const isInternalRelayRequest = (headers: Record<string, unknown>): boolean => {
    const provided = String((headers || {})[INTERNAL_RELAY_AUTH_HEADER] || '');
    return !!provided && secureCompare(provided, INTERNAL_RELAY_AUTH_TOKEN);
};

const normalizeHostname = (hostname: string): string =>
    String(hostname || '')
        .trim()
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split('%')[0]          // strip IPv6 zone id
        .toLowerCase()
        .replace(/\.+$/, '');   // strip trailing dots (`localhost.` -> `localhost`)

const parseIpv4Octets = (host: string): number[] | null => {
    if (isIP(host) !== 4) return null;
    return host.split('.').map((part) => parseInt(part, 10));
};

const isBlockedIpv4 = (octets: number[]): boolean => {
    const a = octets[0];
    const b = octets[1];
    const c = octets[2];
    if (a === 0) return true;                          // 0.0.0.0/8 (unspecified)
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true;                        // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a >= 224) return true;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
    return false;
};

/**
 * Expands an IPv6 literal into its 8 16-bit groups so that every equivalent
 * textual form (compressed `::`, full form, IPv4-mapped hex form
 * `::ffff:7f00:1`, IPv4-compatible `::7f00:1`, ...) canonicalizes to the same
 * representation. Returns null when the literal is not valid IPv6.
 */
const expandIpv6Groups = (host: string): number[] | null => {
    if (isIP(host) !== 6) return null;
    const separator = host.indexOf('::');
    const head = separator === -1 ? host : host.slice(0, separator);
    const tail = separator === -1 ? '' : host.slice(separator + 2);
    // Supports mixed notation (`::ffff:127.0.0.1`) by folding the trailing
    // dotted-quad into two 16-bit groups.
    const parseSide = (side: string): number[] | null => {
        if (side === '') return [];
        const parts = side.split(':');
        const last = parts[parts.length - 1];
        if (last.indexOf('.') !== -1) {
            const octets = parseIpv4Octets(last);
            if (!octets) return null;
            parts.pop();
            return parts
                .map((group) => parseInt(group, 16))
                .concat([(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]);
        }
        return parts.map((group) => parseInt(group, 16));
    };
    const headGroups = parseSide(head);
    const tailGroups = parseSide(tail);
    if (!headGroups || !tailGroups) return null;
    const fillCount = 8 - headGroups.length - tailGroups.length;
    const groups = separator === -1
        ? headGroups
        : headGroups.concat(fillCount > 0 ? new Array(fillCount).fill(0) : [], tailGroups);
    return groups.length === 8 && groups.every((group) => Number.isFinite(group)) ? groups : null;
};

const isBlockedIpv6Groups = (groups: number[]): boolean => {
    const first = groups[0];
    const isZeroPrefix = (upTo: number) => groups.slice(0, upTo).every((group) => group === 0);
    const embeddedIpv4 = (hi: number, lo: number): number[] => [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];

    if (groups.every((group) => group === 0)) return true;                   // :: unspecified
    if (isZeroPrefix(7) && groups[7] === 1) return true;                     // ::1 loopback
    if ((first & 0xfe00) === 0xfc00) return true;                            // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true;                            // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfec0) return true;                            // fec0::/10 site-local (deprecated)
    if ((first & 0xff00) === 0xff00) return true;                            // ff00::/8 multicast
    if (first === 0x64 && groups[1] === 0xff9b) return true;                 // 64:ff9b::/32 NAT64 (well-known + local-use)
    // IPv4-mapped ::ffff:a.b.c.d (also seen in hex form ::ffff:7f00:1), the
    // IPv4-translated (SIIT) form ::ffff:0:a.b.c.d and the IPv4-compatible form
    // ::a.b.c.d all embed an IPv4 address in the last 32 bits. Issue #1 round 2 /
    // NEW-4: the SIIT form previously bypassed the IPv4 blocklist.
    if (
        (isZeroPrefix(5) && groups[5] === 0xffff) ||
        (isZeroPrefix(4) && groups[4] === 0xffff && groups[5] === 0) ||
        isZeroPrefix(6)
    ) {
        return isBlockedIpv4(embeddedIpv4(groups[6], groups[7]));
    }
    // 6to4 2002::/16 embeds an IPv4 address in groups 1-2.
    if (first === 0x2002) {
        return isBlockedIpv4(embeddedIpv4(groups[1], groups[2]));
    }
    return false;
};

/**
 * Returns true when a URL hostname is a private, loopback, link-local, unspecified,
 * or cloud-metadata address and must not be fetched by the server (SSRF guard).
 */
export const isBlockedBootstrapHost = (hostname: string): boolean => {
    const host = normalizeHostname(hostname);
    if (!host) return true;
    // Conventional loopback names, including trailing-dot and .localdomain
    // spellings (`localhost.`, `localhost.localdomain`).
    if (host === 'localhost' || host === 'localhost.localdomain') return true;
    if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.localdomain')) return true;

    const ipv4Octets = parseIpv4Octets(host);
    if (ipv4Octets) return isBlockedIpv4(ipv4Octets);

    const ipv6Groups = expandIpv6Groups(host);
    if (ipv6Groups) return isBlockedIpv6Groups(ipv6Groups);

    // Not a literal IP address (DNS name); literal-IP checks do not apply here.
    return false;
};

/**
 * Expands an IP literal (v4 or v6) into 8 16-bit groups in IPv4-mapped IPv6
 * space, so v4 and v6 spellings of the same address compare uniformly.
 */
const ipToGroups = (ip: string): number[] | null => {
    const host = normalizeHostname(ip);
    const v4 = parseIpv4Octets(host);
    if (v4) {
        return [0, 0, 0, 0, 0, 0xffff, (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    }
    return expandIpv6Groups(host);
};

type CidrEntry = { network: number[]; bits: number };

/** Canonical text form of an IP literal; IPv4-mapped IPv6 is shown as IPv4. */
const canonicalIp = (ip: string): string | null => {
    const host = normalizeHostname(ip);
    if (!isIP(host)) return null;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    return mapped ? mapped[1] : host;
};

/**
 * Parses an `ip` or `ip/prefix` entry into IPv4-mapped IPv6 space, where IPv4
 * networks sit at ::ffff:0:0/96 (so `10.0.0.0/8` is compared as a 104-bit
 * prefix). Returns null for anything that is not a well-formed address or prefix.
 */
const parseCidr = (entry: string): CidrEntry | null => {
    const raw = String(entry || '').trim();
    const slash = raw.indexOf('/');
    const netPart = slash === -1 ? raw : raw.slice(0, slash);
    const version = isIP(netPart);
    if (!version) return null;
    const maxPrefix = version === 4 ? 32 : 128;
    let prefix = maxPrefix;
    if (slash !== -1) {
        const suffix = raw.slice(slash + 1);
        if (!/^\d{1,3}$/.test(suffix)) return null;
        prefix = Number(suffix);
        if (prefix > maxPrefix) return null;
    }
    const network = ipToGroups(netPart);
    if (!network) return null;
    return { network, bits: version === 4 ? prefix + 96 : prefix };
};

/** True when a TRUST_PROXY_CIDRS entry is a well-formed IP or CIDR. */
export const isValidProxyCidr = (entry: string): boolean => parseCidr(entry) !== null;

/**
 * Membership test for an IP literal against an `ip` or `ip/prefix` entry. An
 * IPv4 peer matches IPv4 entries in either spelling (`10.1.2.3` or
 * `::ffff:10.1.2.3`).
 */
export const isIpInCidr = (ip: string, entry: string): boolean => {
    const network = parseCidr(entry);
    const groups = ipToGroups(ip);
    if (!network || !groups) return false;
    let remaining = network.bits;
    for (let i = 0; i < 8 && remaining > 0; i += 1) {
        const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
        if ((groups[i] & mask) !== (network.network[i] & mask)) return false;
        remaining -= 16;
    }
    return true;
};

/** True when a TCP peer address is inside one of the trusted proxy entries. */
export const isTrustedProxyPeer = (peerAddress: string, trustedProxies: string[]): boolean =>
    trustedProxies.some((entry) => isIpInCidr(peerAddress, entry));

/**
 * The single trusted-client-IP resolver (issue #1 round 2 / NEW-2). Anything
 * that depends on the caller's IP must go through this function.
 *
 * Forwarding headers are believed only when the direct TCP peer is inside
 * `trustedProxies`; otherwise the peer address is returned and headers are
 * ignored. For a trusted peer, `cf-connecting-ip` and then `x-real-ip` are used
 * when present. Otherwise X-Forwarded-For is walked right to left, skipping
 * trusted proxy hops, and the first untrusted hop is the client. A malformed or
 * repeated forwarding header fails closed to the peer address. Returns '' when
 * no usable address exists.
 */
export const resolveClientIp = (
    peerAddress: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    trustedProxies: string[],
): string => {
    const peer = canonicalIp(String(peerAddress || '')) || '';
    if (!peer || !isTrustedProxyPeer(peer, trustedProxies)) return peer;

    for (const name of ['cf-connecting-ip', 'x-real-ip']) {
        const value = headers[name];
        if (value === undefined || String(value).trim() === '') continue;
        return typeof value === 'string' ? canonicalIp(value) || peer : peer;
    }

    const xff = headers['x-forwarded-for'];
    if (xff === undefined || String(xff).trim() === '') return peer;
    if (typeof xff !== 'string') return peer;
    const hops = xff.split(',').map((hop) => canonicalIp(hop));
    if (hops.some((hop) => hop === null)) return peer;
    const chain = hops as string[];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (!isTrustedProxyPeer(chain[i], trustedProxies)) return chain[i];
    }
    return chain[0];
};

/**
 * Credential-bearing query parameter names (issue #1 round 2 / NEW-3). `?apiKey=`
 * is accepted on the WS handshake for browser compatibility, so these values must
 * be redacted before any URL is logged and removed before a URL is dispatched
 * internally.
 */
const SENSITIVE_QUERY_PARAM_KEYS = new Set(['apikey', 'api_key', 'api-key', 'token', 'access_token']);

/**
 * Returns the URL with credential-bearing query values replaced by `REDACTED`
 * (mode `redact`, for log lines) or deleted (mode `remove`, for internal dispatch).
 */
export const scrubSensitiveQuery = (rawUrl: string, mode: 'redact' | 'remove'): string => {
    const value = String(rawUrl || '');
    const qIndex = value.indexOf('?');
    if (qIndex === -1) return value;
    const params = new URLSearchParams(value.slice(qIndex + 1));
    const sensitive: string[] = [];
    params.forEach((_value, key) => {
        if (SENSITIVE_QUERY_PARAM_KEYS.has(key.trim().toLowerCase())) sensitive.push(key);
    });
    for (const key of sensitive) {
        if (mode === 'redact') params.set(key, 'REDACTED');
        else params.delete(key);
    }
    const qs = params.toString();
    return qs ? `${value.slice(0, qIndex)}?${qs}` : value.slice(0, qIndex);
};

export type BootstrapUrlValidation = {
    ok: boolean;
    sourceUrl: string | null;
    error?: string;
};

/**
 * Validates an operator-configured bootstrap seed URL: https:// only unless
 * ALLOW_INSECURE_BOOTSTRAP=1, and never a private/loopback/link-local/metadata host.
 */
export const validateBootstrapSourceUrl = (
    raw: string | undefined,
    allowInsecure: boolean,
): BootstrapUrlValidation => {
    const value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) return { ok: true, sourceUrl: null };

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return { ok: false, sourceUrl: null, error: 'Bootstrap seed URL is not a valid URL' };
    }

    const isHttps = parsed.protocol === 'https:';
    const isInsecureAllowed = allowInsecure && parsed.protocol === 'http:';
    if (!isHttps && !isInsecureAllowed) {
        return {
            ok: false,
            sourceUrl: null,
            error: 'Bootstrap seed URL must use https:// (set ALLOW_INSECURE_BOOTSTRAP=1 to permit http://)',
        };
    }

    if (isBlockedBootstrapHost(parsed.hostname)) {
        return {
            ok: false,
            sourceUrl: null,
            error: 'Bootstrap seed URL must not point to a private, loopback, link-local or metadata address',
        };
    }

    return { ok: true, sourceUrl: value };
};
