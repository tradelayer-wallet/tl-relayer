// src/services/attestation.service.ts
import axios from 'axios';

export interface IpAttestationResult {
  success: boolean;
  ip: string;
  countryCode?: string;
  isVpn?: boolean;
  isProxy?: boolean;
  isDarkweb?: boolean;
  isAnonymousVpn?: boolean;
  isBlocked: boolean;
  source: 'criminalip' | 'ipinfo' | 'unknown';
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

export class AttestationService {
  private readonly CRIMINAL_IP_API_KEY =
    process.env.CRIMINAL_IP_API_KEY || process.env.VPN_CRIMINALIP || '';
  private readonly IPINFO_TOKEN =
    process.env.IPINFO_TOKEN || process.env.VPN_IPINFO || '';

  private readonly bannedCountries = ['US', 'KP', 'SD', 'RU', 'IR'];
  private readonly cacheTtlMs = Number(process.env.ATTESTATION_CACHE_TTL_MS || 60 * 60 * 1000);
  private readonly failureCacheTtlMs = Number(process.env.ATTESTATION_FAILURE_CACHE_TTL_MS || 60 * 1000);
  private readonly cache = new Map<string, CachedIpAttestation>();

  /**
   * Main entrypoint: given a client IP, run reputation checks.
   * Mirrors your FE AttestationService.checkIP, but server-side.
   */
  async checkIp(ipAddress: string): Promise<IpAttestationResult> {
    const normalizedIp = this.normalizeIp(ipAddress);
    const cached = this.getCached(normalizedIp);
    if (cached) return cached;

    const result = await this.checkIpUncached(normalizedIp);
    this.setCached(normalizedIp, result);
    return result;
  }

  private async checkIpUncached(ipAddress: string): Promise<IpAttestationResult> {
    // 1) Fallback: ipinfo (with explicit IP)
    if (this.IPINFO_TOKEN) {
      console.log('In IPINFO call')
      try {
        const fallbackUrl = `https://ipinfo.io/${ipAddress}?token=${this.IPINFO_TOKEN}`;
        const resp = await axios.get(fallbackUrl, { timeout: 8000 });

        if (resp.status === 200 && resp.data) {
          const data = resp.data as any;
          const ip = data.ip || ipAddress;
          const country = this.normalizeCountryCode(data.country || data.country_code);
          const privacy = data.privacy || {};

          const isVpn = !!privacy.vpn;
          const isProxy = !!privacy.proxy;
          const fromBannedCountry = this.bannedCountries.includes(
            String(country),
          );

          const isBlocked = isVpn || fromBannedCountry;

          if (isBlocked) {
            return this.withLegacyAttestation({
              success: true,
              ip,
              countryCode: country,
              isVpn,
              isProxy,
              isDarkweb: false,
              isAnonymousVpn: false,
              isBlocked: true,
              source: 'ipinfo',
              message:
                'Fallback: Suspicious IP (VPN) or banned country (ipinfo).',
            });
          }

          return this.withLegacyAttestation({
            success: true,
            ip,
            countryCode: country,
            isVpn,
            isProxy,
            isDarkweb: false,
            isAnonymousVpn: false,
            isBlocked: false,
            source: 'ipinfo',
            message: 'Fallback API: IP is clean and trusted (ipinfo).',
          });
        }
      } catch (err: any) {
        console.error('[attestation] ipinfo fallback failed:', err?.message || err);
      }
    }


    console.log('checking IP '+ipAddress)
    // 2) Try CriminalIP if key present
    if (this.CRIMINAL_IP_API_KEY) {
      console.log('trying for crimIP')
      try {
        const primaryUrl =
          `https://api.criminalip.io/v1/asset/ip/report?ip=${ipAddress}`;

        const response = await axios.get(primaryUrl, {
          headers: {
            'x-api-key': this.CRIMINAL_IP_API_KEY,
          },
          timeout: 8000,
        });

        if (response.status === 200 && response.data) {
          const data = response.data as any;
          const issues = data.issues || {};
          const whois = data.whois || {};
          const whoisData: any[] = whois.data || [];

          const countryCode = await this.resolveCountryCode(
            ipAddress,
            this.countryFromCriminalIpData(data, whoisData),
          );

          const fromBannedCountry = whoisData.some(
            (entry: any) =>
              entry &&
              this.bannedCountries.includes(
                (entry.org_country_code ||
                  entry.country_code ||
                  '').toUpperCase(),
              ),
          );

          const isVpn = !!issues.is_vpn;
          const isProxy = !!issues.is_proxy;
          const isDarkweb = !!issues.is_darkweb;
          const isAnonymousVpn = !!issues.is_anonymous_vpn;

          const isBlocked =
            isVpn || isProxy || isDarkweb || isAnonymousVpn || fromBannedCountry;

          if (isBlocked) {
            return this.withLegacyAttestation({
              success: true,
              ip: ipAddress,
              countryCode,
              isVpn,
              isProxy,
              isDarkweb,
              isAnonymousVpn,
              isBlocked: true,
              source: 'criminalip',
              message:
                'Suspicious IP detected or originating from a banned country (CriminalIP).',
            });
          }

          // Clean enough
          return this.withLegacyAttestation({
            success: true,
            ip: ipAddress,
            countryCode,
            isVpn,
            isProxy,
            isDarkweb,
            isAnonymousVpn,
            isBlocked: false,
            source: 'criminalip',
            message: 'IP is clean and trusted (CriminalIP).',
          });
        }
      } catch (err: any) {
        // Primary failed → we will fall back
        console.error('[attestation] CriminalIP failed:', err?.message || err);
      }
    }

    // 3) Last resort: nothing worked / no keys
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

    const ipInfoCountryCode = await this.lookupIpInfoCountryCode(ipAddress);
    if (ipInfoCountryCode) return ipInfoCountryCode;

    const ipApiCountryCode = await this.lookupIpApiCountryCode(ipAddress);
    return ipApiCountryCode || normalized;
  }

  private async lookupIpInfoCountryCode(ipAddress: string): Promise<string | null> {
    try {
      const tokenQuery = this.IPINFO_TOKEN ? `?token=${this.IPINFO_TOKEN}` : '';
      const url = `https://ipinfo.io/${ipAddress}/json${tokenQuery}`;
      const resp = await axios.get(url, { timeout: 5000 });
      if (resp.status !== 200 || !resp.data) return null;
      const data = resp.data as any;

      const countryCode = this.normalizeCountryCode(
        data.country || data.country_code,
      );
      return countryCode === 'UNKNOWN' ? null : countryCode;
    } catch (err: any) {
      console.error('[attestation] ipinfo country enrichment failed:', err?.message || err);
      return null;
    }
  }

  private async lookupIpApiCountryCode(ipAddress: string): Promise<string | null> {
    try {
      const url = `http://ip-api.com/json/${ipAddress}?fields=status,countryCode,message`;
      const resp = await axios.get(url, { timeout: 5000 });
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
