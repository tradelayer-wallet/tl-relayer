import { rpcClient } from "../config/rpc.config"

export const getChainInfo = async () => {
    const res = await rpcClient.call('getblockchaininfo');
    return res;
}

import axios from "axios";

const CRIMINAL_IP_API_KEY = "RKohp7pZw3LsXBtbmU3vcaBByraHPzDGrDnE0w1vI0qTEredJnMPfXMRS7Rk";
const IPINFO_TOKEN = "5992daa04f9275";

export const checkIP = async (userIP: string) => {
  try {
    console.log(`Received IP: ${userIP}`);

    let response: any = {
      ip: userIP,
      country: "Unknown",
      is_vpn: false,
      is_proxy: false,
      is_darkweb: false,
      source: "Unknown",
    };

    // Step 1: Primary API - Criminal IP
    try {
      const primaryUrl = `https://api.criminalip.io/v1/asset/ip/report?ip=${userIP}`;
      const primaryResponse = await axios.get(primaryUrl, {
        headers: {
          "x-api-key": CRIMINAL_IP_API_KEY,
        },
      });

      if (primaryResponse.status === 200 && primaryResponse.data) {
        const data = primaryResponse.data;

        response = {
          ip: userIP,
          country: data?.whois?.data?.[0]?.org_country_code || "Unknown",
          is_vpn: data?.issues?.is_anonymous_vpn || data?.issues?.is_vpn || false,
          is_proxy: data?.issues?.is_proxy || false,
          is_darkweb: data?.issues?.is_darkweb || false,
          source: "CriminalIP",
        };

        return { success: true, data: response };
      }
    } catch (error: any) {
      console.warn("Primary API failed:", error.message);
    }

    // Step 2: Fallback API - ipinfo.io
    try {
      const fallbackUrl = `https://ipinfo.io/${userIP}?token=${IPINFO_TOKEN}`;
      const fallbackResponse = await axios.get(fallbackUrl);

      if (fallbackResponse.status === 200 && fallbackResponse.data) {
        const data = fallbackResponse.data;

        response = {
          ip: userIP,
          country: data?.country || "Unknown",
          is_vpn: false, // ipinfo.io doesn't directly provide this information
          is_proxy: data?.privacy?.proxy || false,
          is_darkweb: false, // ipinfo.io doesn't provide this
          source: "IPInfo",
        };

        return { success: true, data: response };
      }
    } catch (error: any) {
      console.warn("Fallback API failed:", error.message);
    }

    throw new Error("Both primary and fallback APIs failed to provide a valid response.");
  } catch (error: any) {
    console.error("Error during IP check:", error.message);
    return {
      success: false,
      error: "Unable to validate IP address.",
    };
  }
};

