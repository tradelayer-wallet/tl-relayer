import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config"

const baseURL = 'https://chain.so/api/v2/';
const { NETWORK } = envConfig;

export const listunspent = async (server: any, params: any[]) => {
    try {
        const address = params?.[2]?.[0];
        const minBlock = params?.[0];
        const maxBlock = params?.[1];
        if (!address) return { error: `Error with getting UTXOs. Code: 0`};
        const vaRes = await rpcClient.call('validateaddress', address);
        if (vaRes.error || !vaRes.data) throw new Error(vaRes.error);
        const pubkey = vaRes.data.pubkey;
        if (pubkey) {
            const luRes = await rpcClient.call('listunspent', ...params);
            if (!luRes.data || luRes.error) throw new Error(`listunspent Error: ${luRes.error}`);
            const data = luRes.data.map((u: any) => {
                return {
                    txid: u.txid,
                    amount: u.amount,
                    confirmations: u.confirmations,
                    scriptPubKey: u.scriptPubKey,
                    vout: u.vout,
                };
            });
            return { data };
        } else {
            const method = 'get_tx_unspent';
            const url = baseURL + method + '/' + NETWORK + '/' + address;
            const { data, error } = await server.axios.get(url);
            if (error || !data) {
                return { error: error || `Error with getting ${address} UTXOs. Code: 1`};
            } else {
                const { status } = data;
                if (status !== 'success') {
                    return { error: `Error with getting ${address} UTXOs. Code: 2`};
                } else {
                    const utxos = data.data.txs
                        .filter(({ confirmations }) => confirmations >= minBlock && confirmations <= maxBlock)
                        .map((u: any) => {
                            return {
                                txid: u.txid,
                                amount: parseFloat(u.value),
                                confirmations: u.confirmations,
                                scriptPubKey: u.script_hex,
                                vout: u.output_no,
                            };
                        });
                    return { data: utxos };
                }
            }
        }
    } catch (err) {
        return { error: err.message };
    }
}