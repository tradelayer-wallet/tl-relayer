import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";

const baseURL = 'https://api.blockcypher.com/v1/';
const token = 'a2b9d2c5fbfc49f39589c2751f599725'; // Your blockcypher token

export const listunspent = async (server: any, params: any[]): Promise<{ data?: any; error?: string }> => {
    try {
        const address = params?.[2]?.[0];
        const minBlock = params?.[0] ?? 1; // Default to 1 if undefined
        const maxBlock = params?.[1] ?? 99999999; // Default to 99999999 if undefined

        if (!address) return { error: `Error with getting UTXOs. Code: 0` };

        const vaRes = await rpcClient.call('validateaddress', address);
        if (vaRes.error || !vaRes.data) throw new Error(`validateaddress Error: ${vaRes.error}`);

        const pubkey = vaRes.data.pubkey;
        if (pubkey) {
            const luRes = await rpcClient.call('listunspent', ...params);
            if (!luRes.data || luRes.error) throw new Error(`listunspent Error: ${luRes.error}`);
            
            const data = luRes.data
                .filter((u: { confirmations: number }) => u.confirmations >= minBlock && u.confirmations <= maxBlock) // Explicitly type u
                .map((u: { txid: string; amount: number; confirmations: number; scriptPubKey: string; vout: number }) => ({
                    txid: u.txid,
                    amount: u.amount,
                    confirmations: u.confirmations,
                    scriptPubKey: u.scriptPubKey,
                    vout: u.vout,
                }));
                
            return { data };
        } else {
            const url = `${baseURL}ltc/${envConfig.NETWORK}/addrs/${address}/balance?token=${token}`;
            const response = await server.axios.get(url);

            const { data, error } = response;
            if (error || !data) {
                return { error: error || `Error with getting ${address} UTXOs. Code: 1` };
            } else if (!data.txrefs) {
                return { error: `Error: No transaction references (UTXOs) for address ${address}.` };
            }

            const utxos = data.txrefs
                .filter(({ confirmations }: { confirmations: number }) => confirmations >= minBlock && confirmations <= maxBlock) // Explicitly type confirmations
                .map((u: { tx_hash: string; value: number; confirmations: number; script: string; tx_output_n: number }) => ({
                    txid: u.tx_hash,
                    amount: u.value / 1e8, // Convert satoshis to LTC
                    confirmations: u.confirmations,
                    scriptPubKey: u.script,
                    vout: u.tx_output_n,
                }));

            return { data: utxos };
        }
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
        return { error: errorMessage };
    }
};
