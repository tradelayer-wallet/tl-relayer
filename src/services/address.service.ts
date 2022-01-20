import { rpcClient } from "../config/rpc.config"

export const validateAddress = async (address:string) => {
    const res = await rpcClient.call('validateaddress', address);
    return res;
}

export const getAddressBalance = async (address: string) => {
    const res = await rpcClient.call('tl_getallbalancesforaddress', address);
    return res;
}