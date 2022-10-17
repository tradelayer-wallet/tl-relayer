import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config"

export const validateAddress = async (address:string) => {
    const res = await rpcClient.call('validateaddress', address);
    return res;
}

export const getAddressBalance = async (address: string) => {
    const res = await rpcClient.call('tl_getallbalancesforaddress', address);
    return res;
}

export const fundAddress = async (address: string) => {
    const network = envConfig.NETWORK;
    if (network.endsWith("TEST")) {
        const res = await rpcClient.call('sendtoaddress', address, 1);
        return res;
    }
    return { error: 'Faucet is Allowed only in TESTNET' };
}

export const getAttestationPayload = async (ip: string, server: any) => {
    try {
        if (!ip) throw new Error("Cant Detect Location");
        const url = `http://www.geoplugin.net/json.gp?ip=${ip}`;
        const { data, error } = await server.axios.get(url);
        if (!data || error) throw new Error(error);
        const { geoplugin_status, geoplugin_countryCode } = data;
        if (!geoplugin_countryCode) throw new Error(`Status Code: ${geoplugin_status}`);
        const payloadRes = await rpcClient.call('tl_createpayload_attestation', geoplugin_countryCode);
        return payloadRes;
    } catch (error: any) {
        return { error: error.message };
    }
}