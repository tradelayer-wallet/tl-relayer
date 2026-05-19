import axios from 'axios';
import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { ELogType, saveLog } from "./utils.service";

const BASE_URL = 'http://localhost:3000';

export type WatchOnlyAccount = {
    address: string;
    pubkey: string;
};

type RpcResult = { data?: any; error?: string };

function trimSlash(value: string): string {
    return String(value || '').replace(/\/+$/, '');
}

function useCollatorRpc(): boolean {
    return !!String(envConfig.COLLATOR_URL || '').trim();
}

export async function callRpc(method: string, ...params: any[]): Promise<RpcResult> {
    if (!useCollatorRpc()) {
        return rpcClient.call(method, ...params);
    }

    const url = trimSlash(envConfig.COLLATOR_URL);
    const res = await axios.post(
        `${url}/rpc/route`,
        {
            service: envConfig.COLLATOR_RPC_SERVICE,
            network: envConfig.COLLATOR_RPC_NETWORK,
            method,
            params,
        },
        { timeout: 15000 },
    );

    const payload: any = res.data || {};
    if (payload.ok === false) {
        return { error: payload?.error?.message || payload?.error || 'Collator RPC failed' };
    }

    return {
        data: payload?.result ?? payload?.data ?? payload,
    };
}

export const validateAddress = async (address: string) => {
    return callRpc('validateaddress', address);
};

export const getAddressBalance = async (address: string) => {
    try {
        const res = await axios.post(`${BASE_URL}/tl_getAllBalancesForAddress`, { params: address });
        return res.data;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        console.error('Error in getAddressBalance:', errorMessage);
        throw new Error(errorMessage);
    }
};

export const fundAddress = async (address: string) => {
    const network = envConfig.NETWORK;
    if (network.endsWith("TEST")) {
        return callRpc('sendtoaddress', address, 1);
    }
    return { error: 'Faucet is Allowed only in TESTNET' };
};

export const importPubKey = async (_server: any, params: any[]): Promise<{ data?: boolean; error?: string }> => {
    try {
        const pubkey = params[0];
        const address = params[1];
        if (!pubkey) throw new Error("Pubkey not provided");

        try {
            const addressList = await callRpc('getaddressesbylabel', "default");
            const addressExists = Object.keys(addressList.data || {}).includes(address);
            if (addressExists) {
                return { data: false };
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
            throw new Error(`Error checking addresses: ${errorMessage}`);
        }

        const ipkRes = await callRpc('importpubkey', pubkey, "default", false);
        if (ipkRes.error) throw new Error(ipkRes.error);

        saveLog(ELogType.PUBKEYS, pubkey);
        return { data: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
        return { error: errorMessage };
    }
};

export const importWatchOnlyAccounts = async (
    _server: any,
    accounts: WatchOnlyAccount[],
): Promise<{ data?: { imported: number; skipped: number; results: Array<{ address: string; imported: boolean; error?: string }> }; error?: string }> => {
    try {
        const results: Array<{ address: string; imported: boolean; error?: string }> = [];
        let imported = 0;
        let skipped = 0;

        for (const account of accounts || []) {
            const address = String(account?.address || '').trim();
            const pubkey = String(account?.pubkey || '').trim();
            if (!address || !pubkey) {
                skipped++;
                continue;
            }

            const res = await importPubKey(_server, [pubkey, address]);
            if (res.error) {
                results.push({ address, imported: false, error: res.error });
                continue;
            }

            if (res.data) {
                imported++;
            } else {
                skipped++;
            }

            results.push({ address, imported: !!res.data });
        }

        return {
            data: {
                imported,
                skipped,
                results,
            },
        };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
        return { error: errorMessage };
    }
};
