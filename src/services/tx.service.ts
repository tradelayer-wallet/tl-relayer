import { rpcClient } from "../config/rpc.config"

export const getTx = async (txid: string) => {
    const res = await rpcClient.call('tl_gettransaction', txid);
    return res;
}
