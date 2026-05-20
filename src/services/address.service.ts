import axios from 'axios';
import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { ELogType, saveLog } from "./utils.service";
import {
    reconcileWatchOnlyRegistry,
    resolveWatchOnlyPubkey,
    upsertWatchOnlyAccounts,
} from "./watchonly-registry.service";

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

export function isCollatorMode(): boolean {
    return useCollatorRpc();
}

export async function callRpc(method: string, ...params: any[]): Promise<RpcResult> {
    if (!useCollatorRpc()) {
        return rpcClient.call(method, ...params);
    }

    try {
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
    } catch (error: any) {
        const payload = error?.response?.data;
        const message =
            payload?.error?.message ||
            payload?.error ||
            error?.message ||
            'Collator RPC failed';
        return { error: message };
    }
}

export const validateAddress = async (address: string) => {
    return callRpc('validateaddress', address);
};

export const getAddressBalance = async (address: string) => {
    try {
        if (isCollatorMode()) {
            const res = await callRpc('tl_getallbalancesforaddress', address);
            if (res.error) {
                throw new Error(res.error);
            }
            return res.data;
        }

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

        const res = await upsertWatchOnlyAccounts([
            { address: String(address || '').trim(), pubkey: String(pubkey || '').trim() },
        ]);
        const first = res.results[0];
        if (first?.error) throw new Error(first.error);
        return { data: !!first?.imported };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
        return { error: errorMessage };
    }
};

export const importWatchOnlyAccounts = async (
    _server: any,
    accounts: WatchOnlyAccount[],
): Promise<{ data?: { imported: number; skipped: number; refreshed: number; updated: number; failed: number; snapshot: unknown; results: Array<{ address: string; imported: boolean; error?: string }> }; error?: string }> => {
    try {
        const res = await upsertWatchOnlyAccounts(
            (accounts || []).map((account) => ({
                address: String(account?.address || '').trim(),
                pubkey: String(account?.pubkey || '').trim(),
            })),
            { source: 'sync-watchonly' }
        );

        return {
            data: {
                imported: res.imported,
                skipped: res.skipped,
                refreshed: res.refreshed,
                updated: res.updated,
                failed: res.failed,
                snapshot: res.snapshot,
                results: res.results.map((item) => ({
                    address: item.address,
                    imported: item.imported,
                    error: item.error,
                })),
            },
        };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
        return { error: errorMessage };
    }
};

export const getWatchOnlyRegistryPubkey = async (address: string): Promise<string | undefined> => {
    return resolveWatchOnlyPubkey(address);
};

export const reconcileWatchOnlyAccounts = async () => {
    return reconcileWatchOnlyRegistry();
};
