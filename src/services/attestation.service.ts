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
}

export class AttestationService {
  private readonly CRIMINAL_IP_API_KEY =
    process.env.CRIMINAL_IP_API_KEY || '';
  private readonly IPINFO_TOKEN =
    process.env.IPINFO_TOKEN || '';

  private readonly bannedCountries = ['US', 'KP', 'SY', 'SD', 'RU', 'IR'];

  /**
   * Main entrypoint: given a client IP, run reputation checks.
   * Mirrors your FE AttestationService.checkIP, but server-side.
   */
  async checkIp(ipAddress: string): Promise<IpAttestationResult> {
    // 1) Try CriminalIP if key present
    if (this.CRIMINAL_IP_API_KEY) {
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

          const countryCode =
            whoisData[0]?.org_country_code ||
            whoisData[0]?.country_code ||
            'Unknown';

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
            return {
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
            };
          }

          // Clean enough
          return {
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
          };
        }
      } catch (err: any) {
        // Primary failed → we will fall back
        console.error('[attestation] CriminalIP failed:', err?.message || err);
      }
    }

    // 2) Fallback: ipinfo (with explicit IP)
    if (this.IPINFO_TOKEN) {
      try {
        const fallbackUrl = `https://ipinfo.io/${ipAddress}?token=${this.IPINFO_TOKEN}`;
        const resp = await axios.get(fallbackUrl, { timeout: 8000 });

        if (resp.status === 200 && resp.data) {
          const data = resp.data as any;
          const ip = data.ip || ipAddress;
          const country = data.country || 'Unknown';
          const privacy = data.privacy || {};

          const isVpn = !!privacy.vpn;
          const isProxy = !!privacy.proxy;
          const fromBannedCountry = this.bannedCountries.includes(
            String(country).toUpperCase(),
          );

          const isBlocked = isVpn || fromBannedCountry;

          if (isBlocked) {
            return {
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
            };
          }

          return {
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
          };
        }
      } catch (err: any) {
        console.error('[attestation] ipinfo fallback failed:', err?.message || err);
      }
    }

    // 3) Last resort: nothing worked / no keys
    return {
      success: false,
      ip: ipAddress,
      isBlocked: false,
      source: 'unknown',
      message: 'No IP reputation provider succeeded',
      error:
        'Both primary and fallback IP reputation APIs failed or are not configured.',
    };
  }
}
