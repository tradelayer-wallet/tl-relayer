import { rpcClient } from "../config/rpc.config"

export const getChainInfo = async () => {
    const res = await rpcClient.call('getblockchaininfo');
    return res;
}

import axios from "axios";

const CRIMINAL_IP_API_KEY = "RKohp7pZw3LsXBtbmU3vcaBByraHPzDGrDnE0w1vI0qTEredJnMPfXMRS7Rk";
const IPINFO_TOKEN = "5992daa04f9275";

async function checkUserIP(): Promise<any> {
  try {
    // Step 1: Capture user's IP
    const userIP = await getUserPublicIP();
    console.log(`User's public IP: ${userIP}`);

    // Step 2: Primary API - Criminal IP
    const primaryUrl = `https://api.criminalip.io/v1/asset/ip/report?ip=${userIP}`;
    const primaryResponse = await axios.get(primaryUrl, {
      headers: {
        "x-api-key": CRIMINAL_IP_API_KEY,
      },
    });

    if (primaryResponse.status === 200 && primaryResponse.data) {
      return primaryResponse.data;
    }

    // Step 3: Fallback API - ipinfo.io
    const fallbackUrl = `https://ipinfo.io/${userIP}?token=${IPINFO_TOKEN}`;
    const fallbackResponse = await axios.get(fallbackUrl);

    if (fallbackResponse.status === 200 && fallbackResponse.data) {
      return fallbackResponse.data;
    }

    throw new Error("Both primary and fallback APIs failed to provide a valid response.");
  } catch (error: any) {
    console.error("Error during IP check:", error.message);
    return {
      success: false,
      error: "Unable to validate IP address.",
    };
  }
}

