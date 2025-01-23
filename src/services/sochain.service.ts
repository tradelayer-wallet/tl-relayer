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
        const minBlock = 0;
        const maxBlock = params[1] ?? 99999999;

        if (!address) {
            return { error: `Error with getting UTXOs. Code: 0` };
        }

        console.log('params in listunspent ' + address + ' ' + pubkey);

                const label = "wallet/tl-relay";
        // Validate the address
        const addressInfo = await rpcClient.call(`getaddressinfo`, address);
        console.log(JSON.stringify(addressInfo));

        if (!addressInfo || !addressInfo.data || !addressInfo.data.ismine) {
            console.log('Address not recognized as owned. ' + JSON.stringify(addressInfo));

            
            // Check if the pubkey needs to be imported
            if (pubkey) {
                const importResult = await importPubKey(server, [pubkey, address]);
                console.log('Import result ' + JSON.stringify(importResult));
                if (importResult.error) {
                    throw new Error(`Failed to import pubkey: ${importResult.error}`);
                }
            } else {
                throw new Error(`Address is not valid and no pubkey provided for import.`);
            }
        }

        // Attempt to fetch unspent UTXOs using the RPC client
        const luRes = await rpcClient.call(`listunspent`, minBlock, maxBlock, [address]);
        console.log('outputs for '+address+' '+JSON.stringify(luRes))
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
    } catch (error: unknown) {
        console.error('Error in listunspent: ', error);
        return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
};
