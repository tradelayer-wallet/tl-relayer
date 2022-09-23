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