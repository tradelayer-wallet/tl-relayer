import { rpcClient } from "../config/rpc.config"

export const getChainInfo = async () => {
    const res = await rpcClient.call('tl_getinfo');
    return res;
}
