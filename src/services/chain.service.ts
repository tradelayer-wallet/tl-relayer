import { rpcClient } from "../config/rpc.config"

export const getChainInfo = async () => {
    const res = await rpcClient.call('getblockchaininfo');
    return res;
}

import axios from "axios";

const CRIMINAL_IP_API_KEY = "RKohp7pZw3LsXBtbmU3vcaBByraHPzDGrDnE0w1vI0qTEredJnMPfXMRS7Rk";
const IPINFO_TOKEN = "5992daa04f9275";

export const checkIP = async () => {
  let ipAddress = "";
  const ipFetchUrls = [
    "http://ip-api.com/json",
    "https://api.ipify.org?format=json",
  ];

  // Step 1: Fetch the client IP address from available sources
  for (const url of ipFetchUrls) {
    try {
      const response = await axios.get(url);
      const data = response.data;

      if (data?.ip) {
        ipAddress = data.ip; // For ipify.org
        console.log(`IP fetched from ${url}: ${ipAddress}`);
        break;
      } else if (data?.query) { // For ip-api.com
        ipAddress = data.query;
        console.log(`IP fetched from ${url}: ${ipAddress}`);
        break;
      }
    } catch (error) {
      console.error(`Failed to fetch IP from ${url}:`, error.message);
    }
  }

  if (!ipAddress) {
    throw new Error("Unable to determine client IP address from available sources.");
  }

  // Step 2: Call the primary Criminal IP API
  const primaryUrl = `https://api.criminalip.io/v1/asset/ip/report?ip=${ipAddress}`;
  const fallbackUrl = `https://ipinfo.io/json?token=${IPINFO_TOKEN}`;
  const bannedCountries = ["US", "KP", "SY", "SD", "RU", "IR"]; // Add sanctioned country codes

  try {
    const response = await axios.get(primaryUrl, {
      headers: {
        "x-api-key": CRIMINAL_IP_API_KEY,
      },
    });

    if (response.status === 200 && response.data) {
      const { issues, whois } = response.data;

      if (
        issues.is_vpn ||
        issues.is_darkweb ||
        issues.is_proxy ||
        issues.is_anonymous_vpn ||
        (whois?.data || []).some((entry: { org_country_code: string }) =>
          bannedCountries.includes(entry.org_country_code)
        )
      ) {
        throw new Error("Suspicious IP detected or originating from a banned country.");
      }

      const countryCode = whois?.data?.[0]?.org_country_code || "Unknown";
      return {
        success: true,
        attestation: {
          ip: ipAddress,
          country: countryCode,
          message: "IP is clean and trusted.",
        },
      };
    } else {
      throw new Error("No response or invalid response from primary IP API.");
    }
  } catch (error: any) {
    console.error("Primary API failed:", error.message);

    // Step 3: Fallback to ipinfo.io
    try {
      const fallbackResponse = await axios.get(fallbackUrl);
      const fallbackData = fallbackResponse.data;

      if (fallbackData) {
        const { ip, country, privacy } = fallbackData;

        if (privacy?.vpn || bannedCountries.includes(country)) {
          throw new Error("Fallback: Suspicious IP detected or IP is in a banned country.");
        }

        return {
          success: true,
          attestation: {
            ip,
            countryCode: country,
            message: "Fallback API: IP is clean and trusted.",
          },
        };
      } else {
        throw new Error("No response from fallback API.");
      }
    } catch (fallbackError: any) {
      console.error("Fallback API failed:", fallbackError.message);
      return {
        success: false,
        error: "Both primary and fallback APIs failed.",
      };
    }
  }
};
