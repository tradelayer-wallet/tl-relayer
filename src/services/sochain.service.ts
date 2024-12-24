import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { importPubKey } from "./address.service";

const baseURL = "https://api.blockcypher.com/v1/";
const token = "a2b9d2c5fbfc49f39589c2751f599725"; // BlockCypher API token

export const listunspent = async (
    server: any,
    params: [number, number, { address: string; pubkey?: string }]
): Promise<{ data?: any; error?: string }> => {
    try {
        const { address, pubkey } = params[2];
        const minBlock = params[0] ?? 1;
        const maxBlock = params[1] ?? 99999999;

        if (!address) return { error: `Error with getting UTXOs. Code: 0` };
        console.log('params in listunspent '+address+' '+pubkey)
        // Validate the address
        const vaRes = await rpcClient.call("validateaddress", address);
        if (!vaRes.data.isvalid) {
              // Check if the pubkey needs to be imported
            console.log('inside vaRest data.isvalid=false '+JSON.stringify(vaRes)
            if (pubkey) {
                const importResult = await importPubKey(server, [pubkey, address]);
                console.log('import result '+importResult) 
                if (importResult.error) {
                    throw new Error(`Failed to import pubkey: ${importResult.error}`);
                }
            }
        }

        // Attempt to fetch unspent UTXOs using the RPC client
        const luRes = await rpcClient.call("listunspent", minBlock, maxBlock, [address]);
        if (luRes.error || !luRes.data) {
            throw new Error(`listunspent RPC error: ${luRes.error}`);
        }

        // Filter and map the UTXOs
        const data = luRes.data
            .filter(
                (u: { confirmations: number }) =>
                    u.confirmations >= minBlock && u.confirmations <= maxBlock
            )
            .map(
                (u: {
                    txid: string;
                    amount: number;
                    confirmations: number;
                    scriptPubKey: string;
                    vout: number;
                }) => ({
                    txid: u.txid,
                    amount: u.amount,
                    confirmations: u.confirmations,
                    scriptPubKey: u.scriptPubKey,
                    vout: u.vout,
                })
            );

        return { data };
    } catch (nodeError: unknown) {
        const errorMessage =
            nodeError instanceof Error ? nodeError.message : "An unexpected error occurred";

        console.warn("Node UTXO fetch failed, falling back to BlockCypher:", errorMessage);

        // Fallback to BlockCypher API
        try {
            const url = `${baseURL}ltc/${envConfig.NETWORK}/addrs/${params[2].address}/balance?token=${token}`;
            const response = await server.axios.get(url);

            const { data, error } = response;
            if (error || !data) {
                return { error: error || `Error with getting ${params[2].address} UTXOs. Code: 1` };
            } else if (!data.txrefs) {
                return { error: `Error: No transaction references (UTXOs) for address ${params[2].address}.` };
            }

            const utxos = data.txrefs
                .filter(
                    ({ confirmations }: { confirmations: number }) =>
                        confirmations >= params[0] && confirmations <= params[1]
                )
                .map(
                    (u: {
                        tx_hash: string;
                        value: number;
                        confirmations: number;
                        script: string;
                        tx_output_n: number;
                    }) => ({
                        txid: u.tx_hash,
                        amount: u.value / 1e8, // Convert satoshis to LTC
                        confirmations: u.confirmations,
                        scriptPubKey: u.script,
                        vout: u.tx_output_n,
                    })
                );

            return { data: utxos };
        } catch (blockCypherError: unknown) {
            const errorMessage =
                blockCypherError instanceof Error
                    ? blockCypherError.message
                    : "An unexpected error occurred during BlockCypher fallback.";
            return { error: errorMessage };
        }
    }
};
