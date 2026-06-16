import axios from 'axios';
import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { ELogType, saveLog } from "./utils.service";
import {
    reconcileWatchOnlyRegistry,
    resolveWatchOnlyPubkey,
    upsertWatchOnlyAccounts,
} from "./watchonly-registry.service";

export type WatchOnlyAccount = {
    address: string;
    pubkey: string;
};

type RpcResult = { data?: any; error?: string };

export type AllocatedRpcOptions = {
    preferredProviderNodeId?: string;
    service?: string;
    network?: string;
    timeoutMs?: number;
};

const PORTFOLIO_HEARTBEAT_METHODS = new Set([
    'validateaddress',
    'getaddressinfo',
    'getblockchaininfo',
    'importpubkey',
    'listunspent',
    'sendtoaddress',
    'tl_getallbalancesforaddress',
]);

function trimSlash(value: string): string {
    return String(value || '').replace(/\/+$/, '');
}

const TRADELAYER_LISTENER_METHODS: Record<string, string> = {
    tl_getallbalancesforaddress: 'tl_getAllBalancesForAddress',
    tl_listproperties: 'tl_listProperties',
    tl_getproperty: 'tl_getProperty',
    tl_getbalance: 'tl_getBalance',
    tl_getinfo: 'tl_getInfo',
    tl_getchannel: 'tl_getChannel',
    tl_createrawtx_opreturn: 'tl_createrawtx_opreturn',
    tl_createrawtx_reference: 'tl_createrawtx_reference',
    tl_decodetransaction: 'tl_decodeTx',
    tl_getcontractinfo: 'tl_getContractInfo',
    tl_channelbalanceforcommiter: 'tl_channelBalanceForCommiter',
    tl_getinitmargin: 'tl_getInitMargin',
    tl_tokentradehistoryforaddress: 'tl_tokenTradeHistoryForAddress',
    tl_contracttradehistoryforaddress: 'tl_contractTradeHistoryForAddress',
    tl_totaltradehistoryforaddress: 'tl_totalTradeHistoryForAddress',
    tl_listcontractseries: 'tl_listContractSeries',
    tl_getattestations: 'tl_getAttestations',
    tl_getchannelcolumn: 'tl_getChannelColumn',
    tl_gettransaction: 'tl_getTransaction',
};

function getTradeLayerListenerMethod(method: string): string | undefined {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    return TRADELAYER_LISTENER_METHODS[normalizedMethod];
}

function buildListenerBody(method: string, params: any[]): Record<string, unknown> {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const first = params?.[0];

    if (normalizedMethod === 'tl_getattestations') {
        return {
            address: params?.[0],
            id: params?.[1],
        };
    }

    if (normalizedMethod === 'tl_getchannelcolumn') {
        return {
            channelAddress: params?.[0],
            cpAddress: params?.[1],
        };
    }

    if (normalizedMethod === 'tl_gettransaction') {
        return { txid: first };
    }

    return {
        params: params.length <= 1 ? first : params,
    };
}

async function callTradeLayerListener(method: string, params: any[]): Promise<RpcResult> {
    const listenerMethod = getTradeLayerListenerMethod(method);
    if (!listenerMethod) {
        return rpcClient.call(method, ...params);
    }

    try {
        const url = `${trimSlash(envConfig.TL_LISTENER_URL)}/${listenerMethod}`;
        const res = await axios.post(url, buildListenerBody(method, params), { timeout: 15000 });
        return { data: res.data };
    } catch (error: any) {
        const payload = error?.response?.data;
        return {
            error:
                payload?.error?.message ||
                payload?.error ||
                (typeof payload === 'string' ? payload : undefined) ||
                error?.message ||
                'TradeLayer listener call failed',
            statusCode: error?.response?.status,
        } as RpcResult;
    }
}

export async function callAllocatedRpc(
    method: string,
    params: any[] = [],
    options: AllocatedRpcOptions = {},
): Promise<RpcResult & { providerNodeId?: string }> {
    if (!useCollatorRpc()) {
        return callRpc(method, ...params);
    }

    const providerNodeId = sanitizeProviderNodeId(options.preferredProviderNodeId);

    try {
        const url = trimSlash(envConfig.COLLATOR_URL);
        console.log('[portfolio-heartbeat][relayer][rpc-allocated] request', {
            method,
            service: options.service || envConfig.COLLATOR_RPC_SERVICE,
            network: options.network || envConfig.COLLATOR_RPC_NETWORK || null,
            preferredProviderNodeId: providerNodeId || null,
            route: '/rpc/route',
        });
        const res = await axios.post(
            `${url}/rpc/route`,
            {
                service: options.service || envConfig.COLLATOR_RPC_SERVICE,
                network: options.network || envConfig.COLLATOR_RPC_NETWORK,
                method,
                params,
                timeoutMs: options.timeoutMs,
                preferredProviderNodeId: providerNodeId,
                sourceEndpoint: 'testnet-api',
            },
            { timeout: 15000 },
        );

        const payload: any = res.data || {};
        if (payload.ok === false) {
            console.warn('[portfolio-heartbeat][relayer][rpc-allocated] failure', {
                method,
                providerNodeId: providerNodeId || null,
                error: payload?.error?.message || payload?.error || 'Collator RPC failed',
            });
            return { error: payload?.error?.message || payload?.error || 'Collator RPC failed' };
        }

        console.log('[portfolio-heartbeat][relayer][rpc-allocated] response', {
            method,
            providerNodeId: payload?.providerNodeId || null,
            hasData: payload?.result != null || payload?.data != null,
        });

        return {
            data: payload?.result ?? payload?.data ?? payload,
            providerNodeId: typeof payload?.providerNodeId === 'string' && payload.providerNodeId.trim()
                ? payload.providerNodeId.trim()
                : undefined,
        };
    } catch (error: any) {
        const payload = error?.response?.data;
        const message =
            payload?.error?.message ||
            payload?.error ||
            error?.message ||
            'Collator RPC failed';
        console.warn('[portfolio-heartbeat][relayer][rpc-allocated] error', {
            method,
            providerNodeId: providerNodeId || null,
            message,
        });
        return { error: message };
    }
}

function useCollatorRpc(): boolean {
    return !!String(envConfig.COLLATOR_URL || '').trim();
}

function sanitizeProviderNodeId(providerNodeId?: string): string | undefined {
    const value = String(providerNodeId || '').trim();
    return value || undefined;
}

function isPortfolioHeartbeatRpc(method: string): boolean {
    return PORTFOLIO_HEARTBEAT_METHODS.has(String(method || '').trim().toLowerCase());
}

function summarizePortfolioHeartbeatRpc(method: string, params: any[]): Record<string, unknown> {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const first = params?.[0];
    const second = params?.[1];
    const third = params?.[2];

    if (normalizedMethod === 'listunspent' && third && typeof third === 'object') {
        return {
            minBlock: first,
            maxBlock: second,
            address: String(third.address || '').trim(),
            hasPubkey: !!third.pubkey,
        };
    }

    if (normalizedMethod === 'importpubkey') {
        return {
            hasPubkey: !!first,
            address: String(second || '').trim(),
        };
    }

    if (
        normalizedMethod === 'validateaddress' ||
        normalizedMethod === 'getaddressinfo' ||
        normalizedMethod === 'tl_getallbalancesforaddress' ||
        normalizedMethod === 'sendtoaddress' ||
        normalizedMethod === 'tl_getproperty' ||
        normalizedMethod === 'tl_listproperties'
    ) {
        return { address: String(first || '').trim() };
    }

    return { paramsCount: params.length };
}

export function isCollatorMode(): boolean {
    return useCollatorRpc();
}

export async function callRpc(method: string, ...params: any[]): Promise<RpcResult> {
    if (!useCollatorRpc()) {
        return callTradeLayerListener(method, params);
    }

    try {
        const url = trimSlash(envConfig.COLLATOR_URL);
        if (isPortfolioHeartbeatRpc(method)) {
            console.log('[portfolio-heartbeat][relayer][rpc] request', {
                method,
                service: envConfig.COLLATOR_RPC_SERVICE,
                network: envConfig.COLLATOR_RPC_NETWORK || null,
                route: '/rpc/route',
                ...summarizePortfolioHeartbeatRpc(method, params),
            });
        }
        const res = await axios.post(
            `${url}/rpc/route`,
            {
                service: envConfig.COLLATOR_RPC_SERVICE,
                network: envConfig.COLLATOR_RPC_NETWORK,
                method,
                params,
                sourceEndpoint: 'testnet-api',
            },
            { timeout: 15000 },
        );

        const payload: any = res.data || {};
        if (payload.ok === false) {
            if (isPortfolioHeartbeatRpc(method)) {
                console.warn('[portfolio-heartbeat][relayer][rpc] failure', {
                    method,
                    error: payload?.error?.message || payload?.error || 'Collator RPC failed',
                });
            }
            return { error: payload?.error?.message || payload?.error || 'Collator RPC failed' };
        }

        if (isPortfolioHeartbeatRpc(method)) {
            console.log('[portfolio-heartbeat][relayer][rpc] response', {
                method,
                hasData: payload?.result != null || payload?.data != null,
                providerNodeId: payload?.providerNodeId || null,
                responseType: Array.isArray(payload?.result ?? payload?.data ?? payload) ? 'array' : typeof (payload?.result ?? payload?.data ?? payload),
            });
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
        if (isPortfolioHeartbeatRpc(method)) {
            console.warn('[portfolio-heartbeat][relayer][rpc] error', {
                method,
                message,
            });
        }
        return { error: message };
    }
}

export const validateAddress = async (address: string) => {
    return callRpc('validateaddress', address);
};

export const getAddressBalance = async (address: string) => {
    try {
        console.log('[portfolio-heartbeat][relayer][balance] request', {
            address: String(address || '').trim(),
            collatorMode: isCollatorMode(),
            mappedRpc: 'tl_getallbalancesforaddress',
        });
        const res = await callRpc('tl_getallbalancesforaddress', address);
        if (res.error) {
            throw new Error(res.error);
        }
        console.log('[portfolio-heartbeat][relayer][balance] response', {
            address: String(address || '').trim(),
            hasData: res.data != null,
            responseType: Array.isArray(res.data) ? 'array' : typeof res.data,
        });
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

        console.log('[portfolio-heartbeat][relayer][watchonly-import] request', {
            address: String(address || '').trim(),
            hasPubkey: !!pubkey,
            sourceEndpoint: 'testnet-api',
            mappedRpc: 'importpubkey',
        });

        const res = await upsertWatchOnlyAccounts([
            { address: String(address || '').trim(), pubkey: String(pubkey || '').trim() },
        ]);
        const first = res.results[0];
        if (first?.error) throw new Error(first.error);
        console.log('[portfolio-heartbeat][relayer][watchonly-import] response', {
            address: String(address || '').trim(),
            imported: !!first?.imported,
            skipped: !!first?.skipped,
            refreshed: !!first?.refreshed,
            updated: !!first?.updated,
        });
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
        console.log('[portfolio-heartbeat][relayer][watchonly-sync] request', {
            count: Array.isArray(accounts) ? accounts.length : 0,
            addresses: (accounts || []).map((account) => String(account?.address || '').trim()).filter(Boolean),
            sourceEndpoint: 'testnet-api',
            mappedRpc: 'importpubkey',
        });
        const res = await upsertWatchOnlyAccounts(
            (accounts || []).map((account) => ({
                address: String(account?.address || '').trim(),
                pubkey: String(account?.pubkey || '').trim(),
            })),
            { source: 'sync-watchonly' }
        );

        console.log('[portfolio-heartbeat][relayer][watchonly-sync] response', {
            imported: res.imported,
            refreshed: res.refreshed,
            skipped: res.skipped,
            updated: res.updated,
            failed: res.failed,
        });

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
        console.warn('[portfolio-heartbeat][relayer][watchonly-sync] failed', errorMessage);
        return { error: errorMessage };
    }
};

export const getWatchOnlyRegistryPubkey = async (address: string): Promise<string | undefined> => {
    return resolveWatchOnlyPubkey(address);
};

export const reconcileWatchOnlyAccounts = async () => {
    return reconcileWatchOnlyRegistry();
};
