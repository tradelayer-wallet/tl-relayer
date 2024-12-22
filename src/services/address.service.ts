import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { ELogType, saveLog } from "./utils.service";
import axios from 'axios';

const BASE_URL = 'http://localhost:3000'; // Your Express server base URL


export const validateAddress = async (address:string) => {
    const res = await rpcClient.call('validateaddress', address);
    return res;
}

export const getAddressBalance = async (address) => {
  try {
    const res = await axios.post(`${BASE_URL}/tl_getAllBalancesForAddress`, { params: address });
    return res.data;
  } catch (error) {
    console.error('Error in getAddressBalance:', error);
    throw error;
  }
};


export const fundAddress = async (address: string) => {
    const network = envConfig.NETWORK;
    if (network.endsWith("TEST")) {
        const res = await rpcClient.call('sendtoaddress', address, 1);
        return res;
    }
    return { error: 'Faucet is Allowed only in TESTNET' };
}

export const importPubKey = async (server: any, params: any[]) => {
    try {
        const pubkey = params[0];
        if (!pubkey) throw new Error("Pubkey not Provided");
        const label = `imported-pubkeys`;
        const ipkRes = await rpcClient.call('importpubkey', pubkey, label, false);
        if (ipkRes.error) throw new Error(ipkRes.error);
        saveLog(ELogType.PUBKEYS, pubkey);
        return { data: true };
    } catch (error) {
        return { error: error.message };
    }
};
