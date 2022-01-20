import { rpcClient } from "../config/rpc.config"

export const getTokenInfo = async (propid: number) => {
    const res = await rpcClient.call('tl_getproperty', propid);
    return res;
}

export const listTokens = async () => {
    const res = await rpcClient.call('tl_listproperties');
    return res;
}