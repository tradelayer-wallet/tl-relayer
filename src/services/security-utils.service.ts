import { createHash, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

/**
 * Lightweight security helpers (issue #1 hardening batch):
 * - constant-time secret comparison for optional API-key gates
 * - SSRF guard for operator-configured bootstrap seed URLs
 */

export const secureCompare = (provided: string, expected: string): boolean => {
    const a = createHash('sha256').update(String(provided || '')).digest();
    const b = createHash('sha256').update(String(expected || '')).digest();
    return timingSafeEqual(a, b) && String(provided || '') === String(expected || '');
};

const stripIpv6Brackets = (hostname: string): string =>
    String(hostname || '').trim().replace(/^\[/, '').replace(/\]$/, '').split('%')[0].toLowerCase();

/**
 * Returns true when a URL hostname is a private, loopback, link-local, unspecified,
 * or cloud-metadata address and must not be fetched by the server (SSRF guard).
 */
export const isBlockedBootstrapHost = (hostname: string): boolean => {
    const host = stripIpv6Brackets(hostname);
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

    const family = isIP(host);
    if (family === 4) {
        const octets = host.split('.').map((part) => parseInt(part, 10));
        const a = octets[0];
        const b = octets[1];
        if (a === 0) return true;                          // 0.0.0.0/8 (unspecified)
        if (a === 10) return true;                         // 10.0.0.0/8
        if (a === 127) return true;                        // 127.0.0.0/8 (loopback)
        if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (link-local / cloud metadata)
        if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
        if (a === 192 && b === 168) return true;           // 192.168.0.0/16
        return false;
    }
    if (family === 6) {
        if (host === '::' || host === '::1') return true;   // unspecified / loopback
        if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 unique-local
        const firstGroup = parseInt(host.split(':')[0] || '0', 16);
        if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;  // fe80::/10 link-local
        const v4Mapped = host.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
        if (v4Mapped && isIP(v4Mapped[1]) === 4) return isBlockedBootstrapHost(v4Mapped[1]);
        return false;
    }
    // Not a literal IP address (DNS name); literal-IP checks do not apply here.
    return false;
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
