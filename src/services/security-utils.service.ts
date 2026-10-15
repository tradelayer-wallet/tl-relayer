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
/**
 * Largest HTTP request body and largest WebSocket relay frame. A frame is buffered whole before
 * the relay sees it, and both surfaces must accept the same request size.
 */
export const REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

/** Headers each credential gate reads, and the message a refused request gets. */
export const RELAYER_KEY_HEADERS = ['x-api-key'];
export const FAUCET_KEY_HEADERS = ['x-api-key', 'x-admin-api-key'];
export const MISSING_KEY_MESSAGE = 'Missing or invalid x-api-key header';

export const INTERNAL_RELAY_AUTH_HEADER = 'x-internal-relay-auth';
export const INTERNAL_RELAY_AUTH_TOKEN = randomBytes(32).toString('hex');

export const isInternalRelayRequest = (headers: Record<string, unknown>): boolean => {
    const provided = String((headers || {})[INTERNAL_RELAY_AUTH_HEADER] || '');
    return !!provided && secureCompare(provided, INTERNAL_RELAY_AUTH_TOKEN);
};

// Longest text this function will classify. A DNS name is at most 253 characters and an IP
// literal with a zone id is far shorter, so anything longer is refused before any pattern runs
// over it (round 8: X-Forwarded-For hops reach this function from clients). Round 10: the cap was
// 128, which refused valid DNS names of 129 to 253 characters as bootstrap sources.
const MAX_HOST_LITERAL_LENGTH = 256;

const normalizeHostname = (hostname: string): string => {
    let host = String(hostname || '').trim();
    if (host.length > MAX_HOST_LITERAL_LENGTH) return '';
    host = host.replace(/^\[/, '').replace(/\]$/, '').split('%')[0].toLowerCase();
    // Strip trailing dots (`localhost.` -> `localhost`) with a linear scan. A pattern such as
    // /\.+$/ backtracks quadratically on a long dot run: about 5 s per 100 kB of input.
    let end = host.length;
    while (end > 0 && host.charCodeAt(end - 1) === 46) end -= 1;
    return host.slice(0, end);
};

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
    // Teredo 2001:0000::/32 embeds the client's IPv4 address obfuscated (bitwise
    // NOT) in groups 6-7; the server address in groups 2-3 is public and ignored.
    if (first === 0x2001 && groups[1] === 0x0000) {
        return isBlockedIpv4(embeddedIpv4(groups[6] ^ 0xffff, groups[7] ^ 0xffff));
    }
    return false;
};

/**
 * Returns true when a URL hostname is a literal private, loopback, link-local,
 * unspecified, or cloud-metadata address (SSRF guard). DNS names are not resolved
 * here, so a public-looking name that resolves to a private address is not caught.
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

/**
 * Canonical text form of an IP literal. IPv4-mapped IPv6 is always shown as dotted
 * IPv4, whatever spelling arrived (`::ffff:1.2.3.4`, `::FFFF:102:304`, ...), so one
 * client has one identity for logging, quotas and provider lookups (round 6 / F-A4).
 */
const canonicalIp = (ip: string): string | null => {
    const host = normalizeHostname(ip);
    if (!isIP(host)) return null;
    const groups = expandIpv6Groups(host);
    if (groups && groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    }
    return host;
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
    // `::ffff:a.b.c.d/p` is an IPv4-mapped literal whose prefix is ambiguous: read as an
    // IPv6 prefix it would match whole IPv6 ranges and every IPv4 peer (round 3 / F10).
    // Only the IPv4 spelling (`a.b.c.d/p`) or a prefix of 96 or more is accepted.
    const isMapped = version === 6 && network.slice(0, 5).every((group) => group === 0) && network[5] === 0xffff;
    if (isMapped && prefix < 96) return null;
    return { network, bits: version === 4 ? prefix + 96 : prefix };
};

/** True when a TRUST_PROXY_CIDRS entry is a well-formed IP or CIDR. */
export const isValidProxyCidr = (entry: string): boolean => parseCidr(entry) !== null;

/**
 * True when a TRUST_PROXY_CIDRS entry is too broad to trust by default. Trusting such
 * an entry lets a large share of clients, possibly all of them, supply their own
 * client IP (round 6 / F-A3, round 7 / F-B1). Broad means any of:
 * - it covers every IPv4 address (`0.0.0.0/0`, `::/0`, `::/64`, `::ffff:0:0/96`, ...);
 * - an IPv4 entry (or an IPv4-mapped entry) with a prefix shorter than /8;
 * - a non-mapped IPv6 entry with a prefix shorter than /16.
 * Callers must reject these unless the operator opts in explicitly.
 */
export const isBroadProxyCidr = (entry: string): boolean => {
    const network = parseCidr(entry);
    if (!network) return false;
    if (isIpInCidr('::ffff:0.0.0.0', entry) && isIpInCidr('::ffff:255.255.255.255', entry)) return true;
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    // `bits` is the prefix over the 128-bit form: IPv4 entries carry +96 (see parseCidr).
    const mapped = network.network.slice(0, 5).every((group) => group === 0) && network.network[5] === 0xffff;
    if (isIP(address) === 4 || mapped) return network.bits - 96 < 8;
    return network.bits < 16;
};

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
 * The single trusted-client-IP resolver (issue #1 round 2 / NEW-2, round 3 / F1).
 * Anything that depends on the caller's IP must go through this function.
 *
 * Only X-Forwarded-For is believed, and only when the direct TCP peer is inside
 * `trustedProxies`; otherwise the peer address is returned and headers are
 * ignored. The chain is walked right to left, skipping trusted proxy hops, and
 * the first untrusted hop is the client. Each proxy appends the address it
 * received from, so client-supplied prefixes never win. Single-value headers
 * such as cf-connecting-ip or x-real-ip are deliberately not read: a proxy that
 * does not overwrite them would let any client choose its own identity. A
 * malformed hop fails closed to the peer address. Returns '' when no usable
 * address exists. When every hop is a trusted proxy, the TCP peer is returned.
 */
export const resolveClientIp = (
    peerAddress: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    trustedProxies: string[],
): string => {
    const peer = canonicalIp(String(peerAddress || '')) || '';
    if (!peer || !isTrustedProxyPeer(peer, trustedProxies)) return peer;

    const xff = headers['x-forwarded-for'];
    if (xff === undefined || typeof xff !== 'string' || xff.trim() === '') return peer;
    const hops = xff.split(',').map((hop) => canonicalIp(hop));
    if (hops.some((hop) => hop === null)) return peer;
    const chain = hops as string[];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (!isTrustedProxyPeer(chain[i], trustedProxies)) return chain[i];
    }
    // Every hop is a trusted proxy, so no hop is provably the client. The leftmost hop
    // is whatever the first proxy was sent, which the client controls (round 7 / F-B2).
    // Fail closed to the TCP peer.
    return peer;
};

/**
 * Bucket key for per-client quotas. IPv6 is keyed on its /64 prefix because a
 * single subscriber typically owns a whole /64 and could otherwise mint an
 * unlimited number of distinct per-address buckets (round 3 / F6).
 */
export const rateLimitKey = (ip: string): string => {
    const canonical = canonicalIp(ip);
    if (!canonical) return '';
    if (isIP(canonical) === 4) return canonical;
    const groups = expandIpv6Groups(canonical);
    if (!groups) return canonical;
    return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
};

/**
 * True when any of the named request headers carries the expected secret. This is
 * the one comparison used for every API-key gate, so the hook and the handler
 * cannot disagree about which presented header counts.
 */
export const headerCredentialMatches = (
    headers: Record<string, unknown>,
    headerNames: string[],
    expected: string,
): boolean => {
    if (!expected) return false;
    return headerNames.some((name) => {
        const presented = String(headers[name] || '');
        return !!presented && secureCompare(presented, expected);
    });
};

/**
 * Credential-bearing query parameter names (issue #1 round 2 / NEW-3, round 3 / F3).
 * Matching ignores case, `-` and `_`, so `apiKey`, `API_KEY`, `x-api-key`,
 * `admin_api_key` and `access_token` are all covered. `?apiKey=` is accepted on the
 * WS handshake for browser compatibility, so these values must be redacted before
 * any URL is logged and removed before a URL is dispatched internally.
 */
const isSensitiveQueryKey = (key: string): boolean => {
    const name = key.trim().toLowerCase().replace(/[-_]/g, '');
    return name.endsWith('apikey') || name === 'token' || name === 'accesstoken' || name === 'secret' || name === 'password';
};

/**
 * Returns the URL with credential-bearing query values replaced by `REDACTED`
 * (mode `redact`, for log lines) or deleted (mode `remove`, for internal dispatch).
 * The fragment (`#...`) is dropped in both modes: HTTP clients never send it, and
 * a value written after `#` must not survive as query text (round 3 / F2).
 */
export const scrubSensitiveQuery = (rawUrl: string, mode: 'redact' | 'remove'): string => {
    const raw = String(rawUrl || '');
    const hashIndex = raw.indexOf('#');
    const value = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
    const qIndex = value.indexOf('?');
    if (qIndex === -1) return value;
    // `?` separates parameters as well as `&`. Splitting on `&` alone let a second
    // `?` hide a credential inside the value of the preceding parameter (round 3 / F9).
    const kept: string[] = [];
    for (const segment of value.slice(qIndex + 1).split(/[&?]/)) {
        if (segment === '') continue;
        const eq = segment.indexOf('=');
        const rawKey = eq === -1 ? segment : segment.slice(0, eq);
        let key = '';
        new URLSearchParams(rawKey).forEach((_v, decoded) => {
            if (!key) key = decoded;
        });
        if (!isSensitiveQueryKey(key)) {
            kept.push(segment);
        } else if (mode === 'redact') {
            kept.push(`${rawKey}=REDACTED`);
        }
    }
    return kept.length > 0 ? `${value.slice(0, qIndex)}?${kept.join('&')}` : value.slice(0, qIndex);
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

/**
 * Response-size caps for outbound calls (round 8). A provider, an external UTXO source
 * or an operator seed host that returns an unbounded body (for example 2 GB) would
 * otherwise be buffered whole by axios, which has no default cap. The redirect policy
 * for these calls is `maxRedirects: 0`: a 3xx answer is an error, never a second request
 * that could carry a credential to another host.
 */
export const OUTBOUND_LIMITS = {
    /** Reputation providers (ipinfo, criminalip, ip-api). Real answers are a few KB. */
    providerMaxResponseBytes: 1024 * 1024,
    /** One page of the external UTXO source (chain.so). */
    utxoPageMaxResponseBytes: 4 * 1024 * 1024,
    /** Operator-configured bootstrap seed snapshot (the whole watch-only registry). */
    bootstrapMaxResponseBytes: 32 * 1024 * 1024,
} as const;

/**
 * Address shape accepted before an address is placed in an outbound URL path. Legacy
 * base58 and bech32 addresses (mainnet and testnet) are alphanumeric. Anything else,
 * including `/`, `.`, `?`, `#` and `%`, could change the path or query of the request.
 */
export const isOutboundSafeAddress = (value: string): boolean => /^[A-Za-z0-9]{20,100}$/.test(String(value || ''));
