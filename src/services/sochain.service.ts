import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { importPubKey } from "./address.service"

const baseURL = 'https://api.blockcypher.com/v1/';
const token = 'a2b9d2c5fbfc49f39589c2751f599725'; // Your blockcypher token
export const listunspent = async (
    server: any,
    params: [number, number, { address: string; pubkey?: string }]
): Promise<{ data?: any; error?: string }> => {
    try {
        const [minBlock = 1, maxBlock = 99999999, { address, pubkey }] = params;

        if (!address) return { error: `Error with getting UTXOs. Code: 0` };

        // Check if the address is imported using getaddressesbylabel
        try {
            const label = "tl-relay";

            const addressList = await rpcClient.call("getaddressesbylabel", label);

            // If the address is not found, proceed to import pubkey (if available)
            const addressExists = Object.keys(addressList.data || {}).includes(address);
            if (!addressExists && pubkey) {
                const importRes = await importPubKey(server, [pubkey, address]);
                if (importRes.error) throw new Error(importRes.error);
            }
        } catch (error) {
            if (error.message.includes("Key not found")) {
                // If the label does not exist, attempt to import pubkey (if provided)
                if (pubkey) {
                    const importRes = await importPubKey(server, [pubkey, address]);
                    if (importRes.error) throw new Error(importRes.error);
                }
            } else {
                throw error;
            }
        }

        // Fetch UTXOs from the node
        try {
            const luRes = await rpcClient.call("listunspent", minBlock, maxBlock, [address]);
            if (!luRes.data || luRes.error) throw new Error(`listunspent Error: ${luRes.error}`);

            const data = luRes.data
                .filter(
                    (u: { confirmations: number }) =>
                        u.confirmations >= minBlock && u.confirmations <= maxBlock
                )
                .map(
                    (u: { txid: string; amount: number; confirmations: number; scriptPubKey: string; vout: number }) => ({
                        txid: u.txid,
                        amount: u.amount,
                        confirmations: u.confirmations,
                        scriptPubKey: u.scriptPubKey,
                        vout: u.vout,
                    })
                );

            return { data };
        } catch (nodeError) {
            console.warn("Node UTXO fetch failed, falling back to BlockCypher:", nodeError.message);
        }

        // Fallback: Use BlockCypher API to fetch UTXOs

        const url = `${baseURL}ltc/${envConfig.NETWORK}/addrs/${address}/balance?token=${token}`;
        const response = await server.axios.get(url);

        const { data, error } = response;
        if (error || !data)
            return { error: error || `Error with getting ${address} UTXOs. Code: 1` };

        if (!data.txrefs)
            return { error: `Error: No transaction references (UTXOs) for address ${address}.` };

        const utxos = data.txrefs
            .filter(
                ({ confirmations }: { confirmations: number }) =>
                    confirmations >= minBlock && confirmations <= maxBlock
            )
            .map(
                (u: { tx_hash: string; value: number; confirmations: number; script: string; tx_output_n: number }) => ({
                    txid: u.tx_hash,
                    amount: u.value / 1e8, // Convert satoshis to LTC
                    confirmations: u.confirmations,
                    scriptPubKey: u.script,
                    vout: u.tx_output_n,
                })
            );

        return { data: utxos };
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
        return { error: errorMessage };
    }
};

