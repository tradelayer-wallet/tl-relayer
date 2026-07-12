import axios from 'axios';
import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";
import { ELogType, saveLog } from "./utils.service";
import {
    reconcileWatchOnlyRegistry,
    getWatchOnlyRegistryEntry,
    resolveWatchOnlyPubkey,
    recordTradeLayerRpcSnapshot,
    recordWatchOnlyTokenSnapshot,
    recordWatchOnlySnapshot,
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
    'tl_watchonly_register',
    'tl_watchonly_utxos',
    'tl_getstatesnapshot',
    'tl_gettransaction',
    'tl_getclearlistbyid',
    'tl_listcontractseries',
    'tl_getattestations',
    'tl_getchannelcolumn',
    'tl_getcontractinfo',
    'tl_getchannel',
    'tl_contractposition',
    'tl_channelbalanceforcommiter',
    'tl_tokentradehistoryforaddress',
    'tl_contracttradehistoryforaddress',
    'tl_totaltradehistoryforaddress',
    'tl_getinitmargin',
    'tl_getmaxsynth',
]);

function trimSlash(value: string): string {
    return String(value || '').replace(/\/+$/, '');
}

const TRADELAYER_LISTENER_METHODS: Record<string, string> = {
    tl_getallbalancesforaddress: 'tl_getAllBalancesForAddress',
    tl_getstatesnapshot: 'tl_getStateSnapshot',
    tl_watchonly_register: 'tl_watchonly_register',
    tl_watchonly_utxos: 'tl_watchonly_utxos',
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
    tl_getclearlistbyid: 'tl_getClearlistById',
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

    if (normalizedMethod === 'tl_getclearlistbyid') {
        return { id: first };
    }

    if (normalizedMethod === 'tl_watchonly_register' || normalizedMethod === 'tl_watchonly_utxos') {
        const account = first && typeof first === 'object' && !Array.isArray(first) ? first : {};
        return {
            address: account.address,
            pubkey: account.pubkey || account.pubKey,
            network: account.network,
        };
    }

    return {
        params: params.length <= 1 ? first : params,
    };
}

const TRADELAYER_LISTENER_GET_METHODS = new Set([
    'tl_contractposition',
    'tl_channelbalanceforcommiter',
    'tl_getinitmargin',
    'tl_getcontractinfo',
    'tl_getmaxsynth',
    'tl_tokentradehistoryforaddress',
    'tl_contracttradehistoryforaddress',
    'tl_totaltradehistoryforaddress',
]);

function buildListenerQuery(method: string, params: any[]): Record<string, unknown> {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const first = params?.[0];
    const body = first && typeof first === 'object' && !Array.isArray(first) ? first : null;

    if (normalizedMethod === 'tl_contractposition') {
        return {
            address: body?.address ?? params?.[0],
            contractId: body?.contractId ?? params?.[1],
        };
    }

    if (normalizedMethod === 'tl_channelbalanceforcommiter') {
        return {
            address: params?.[0],
            propertyId: params?.[1],
        };
    }

    if (normalizedMethod === 'tl_getinitmargin') {
        return {
            contractId: body?.contractId ?? params?.[0],
            price: body?.price ?? params?.[1],
        };
    }

    if (normalizedMethod === 'tl_getcontractinfo') {
        return {
            contractId: body?.contractId ?? params?.[0],
        };
    }

    if (normalizedMethod === 'tl_getmaxsynth') {
        return {
            address: body?.address ?? params?.[0],
            propId: body?.propId ?? body?.propertyId ?? params?.[1],
        };
    }

    if (normalizedMethod === 'tl_tokentradehistoryforaddress') {
        return {
            propertyId1: params?.[0],
            propertyId2: params?.[1],
            address: params?.[2],
        };
    }

    if (normalizedMethod === 'tl_contracttradehistoryforaddress') {
        return {
            contractId: params?.[0],
            address: params?.[1],
        };
    }

    if (normalizedMethod === 'tl_totaltradehistoryforaddress') {
        return { address: params?.[0] };
    }

    return {};
}

async function callTradeLayerListener(method: string, params: any[]): Promise<RpcResult> {
    const listenerMethod = getTradeLayerListenerMethod(method);
    if (!listenerMethod) {
        return rpcClient.call(method, ...params);
    }

    try {
        const url = `${trimSlash(envConfig.TL_LISTENER_URL)}/${listenerMethod}`;
        const normalizedMethod = String(method || '').trim().toLowerCase();
        const res = TRADELAYER_LISTENER_GET_METHODS.has(normalizedMethod)
            ? await axios.get(url, { params: buildListenerQuery(method, params), timeout: 15000 })
            : await axios.post(url, buildListenerBody(method, params), { timeout: 15000 });
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

async function recordTradeLayerState(method: string, params: any[], payload: unknown, providerNodeId?: string | null) {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    if (!normalizedMethod.startsWith('tl_')) return;
    const first = params?.[0];
    const second = params?.[1];
    const address =
        normalizedMethod === 'tl_getproperty' ||
        normalizedMethod === 'tl_getinitmargin' ||
        normalizedMethod === 'tl_listproperties'
            ? undefined
            : typeof first === 'string' && first.trim()
                ? String(first).trim()
                : typeof second === 'string' && second.trim()
                    ? String(second).trim()
                    : undefined;
    await recordTradeLayerRpcSnapshot({
        method: normalizedMethod,
        route: '/rpc/route',
        address,
        providerNodeId: providerNodeId || null,
        network: envConfig.COLLATOR_RPC_NETWORK || envConfig.NETWORK || null,
        sourceEndpoint: 'testnet-api',
        summary: { paramsCount: params.length },
        payload,
    }).catch((error) => {
        console.warn('[portfolio-heartbeat][relayer][rpc-state] snapshot failed', {
            method: normalizedMethod,
            error: error instanceof Error ? error.message : error,
        });
    });
}

function scopedWatchOnlyAccount(params: any[]): { address: string; pubkey: string; network?: string } | null {
    const first = params?.[0] && typeof params[0] === 'object' && !Array.isArray(params[0]) ? params[0] : null;
    const address = String(first?.address || '').trim();
    const pubkey = String(first?.pubkey || first?.pubKey || '').trim();
    const network = typeof first?.network === 'string' ? first.network.trim() : undefined;
    if (!address || !pubkey) return null;
    return { address, pubkey, ...(network ? { network } : {}) };
}

async function routeLegacyWatchOnlyCall(
    normalizedMethod: string,
    params: any[],
    options: AllocatedRpcOptions,
): Promise<(RpcResult & { providerNodeId?: string; snapshotHeight?: number | null }) | null> {
    if (normalizedMethod === 'getaddressinfo') {
        // The old portfolio flow probes ownership before registration. Never forward this raw wallet RPC.
        return { data: { ismine: false, iswatchonly: false, watchOnlyScoped: true } };
    }

    if (normalizedMethod === 'getblockchaininfo') {
        // Snapshot responses carry the authoritative source block; callers without an address get no daemon fallback.
        return { data: { blocks: null, watchOnlyScoped: true } };
    }

    if (normalizedMethod !== 'listunspent') return null;
    const filter = params?.[2];
    const account = filter && typeof filter === 'object'
        ? scopedWatchOnlyAccount([{ address: filter.address, pubkey: filter.pubkey, network: filter.network || options.network }])
        : null;
    if (!account) return { error: 'WATCH_ONLY_INVALID_REQUEST: address and pubkey are required for a scoped UTXO snapshot' };

    const snapshot = await callAllocatedRpc('tl_watchonly_utxos', [account], options);
    if (snapshot.error) return snapshot;
    const payload = snapshot.data || {};
    const utxos = Array.isArray(payload.utxos) ? payload.utxos : [];
    const sourceHeight = Number(payload?.snapshot?.sourceBlock?.height);
    const snapshotHeight = Number.isFinite(sourceHeight) && sourceHeight >= 0
        ? Math.floor(sourceHeight)
        : null;
    await recordWatchOnlySnapshot({
        network: payload.network || account.network,
        address: payload.address || account.address,
        pubkey: payload.pubkey || account.pubkey,
        utxos,
        scannedHeight: snapshotHeight,
        scanSourceNodeId: snapshot.providerNodeId || null,
        scanState: 'live',
    }).catch(() => null);
    return { data: utxos, providerNodeId: snapshot.providerNodeId, snapshotHeight };
}

export async function callAllocatedRpc(
    method: string,
    params: any[] = [],
    options: AllocatedRpcOptions = {},
): Promise<RpcResult & { providerNodeId?: string; snapshotHeight?: number | null }> {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const legacyWatchOnly = await routeLegacyWatchOnlyCall(normalizedMethod, params, options);
    if (legacyWatchOnly) return legacyWatchOnly;
    const routedMethod = getTradeLayerListenerMethod(method) || method;
    if (!useCollatorRpc()) {
        if (PORTFOLIO_HEARTBEAT_METHODS.has(normalizedMethod) || normalizedMethod.startsWith('tl_')) {
            return { error: 'Collator routing unavailable for watch-only RPC' };
        }
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
                method: routedMethod,
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

async function resolveWatchOnlyProviderNodeId(address?: string): Promise<string | undefined> {
    const registryEntry = address ? await getWatchOnlyRegistryEntry(address) : null;
    const providerNodeId = sanitizeProviderNodeId(
        registryEntry?.assignedProviderNodeId ||
        registryEntry?.scanSourceNodeId ||
        registryEntry?.lastUtxoSnapshot?.scanSourceNodeId ||
        registryEntry?.lastTokenSnapshot?.scanSourceNodeId ||
        ''
    );
    return providerNodeId || undefined;
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

    if (normalizedMethod === 'tl_getstatesnapshot') {
        return {
            label: String(first || '').trim() || 'TL',
        };
    }

    return { paramsCount: params.length };
}

export function isCollatorMode(): boolean {
    return useCollatorRpc();
}

export async function callRpc(method: string, ...params: any[]): Promise<RpcResult> {
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const routedMethod = getTradeLayerListenerMethod(method) || method;
    if (!useCollatorRpc()) {
        if (PORTFOLIO_HEARTBEAT_METHODS.has(normalizedMethod) || normalizedMethod.startsWith('tl_')) {
            const localRes = await callTradeLayerListener(method, params);
            if (!localRes.error) {
                await recordTradeLayerState(method, params, localRes.data, null);
            }
            return localRes;
        }
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
                method: routedMethod,
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
            const message = payload?.error?.message || payload?.error || 'Collator RPC failed';
            return { error: message };
        }

        if (isPortfolioHeartbeatRpc(method)) {
            console.log('[portfolio-heartbeat][relayer][rpc] response', {
                method,
                hasData: payload?.result != null || payload?.data != null,
                providerNodeId: payload?.providerNodeId || null,
                responseType: Array.isArray(payload?.result ?? payload?.data ?? payload) ? 'array' : typeof (payload?.result ?? payload?.data ?? payload),
            });
        }
        await recordTradeLayerState(method, params, payload?.result ?? payload?.data ?? payload, payload?.providerNodeId || null);
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
        const balances = Array.isArray(res.data) ? res.data : [];
        await recordWatchOnlyTokenSnapshot({
            address: String(address || '').trim(),
            balances: balances.map((token: any) => ({
                propertyId: token?.propertyId ?? token?.propertyid ?? token?.id ?? token?.propertyID ?? '',
                ticker: token?.ticker ?? token?.name ?? token?.label ?? '-',
                amount: Number(token?.amount || 0),
                available: Number(token?.available || 0),
                reserved: Number(token?.reserved || 0),
                margin: Number(token?.margin || 0),
                vesting: Number(token?.vesting || 0),
                channel: Number(token?.channel || 0),
            })),
        }).catch((error) => {
            console.warn('[portfolio-heartbeat][relayer][balance] token-snapshot-cache failed', error instanceof Error ? error.message : error);
        });
        console.log('[portfolio-heartbeat][relayer][balance] response', {
            address: String(address || '').trim(),
            hasData: res.data != null,
            responseType: Array.isArray(res.data) ? 'array' : typeof res.data,
        });
        return balances;
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        const cached = await getWatchOnlyRegistryEntry(String(address || '').trim());
        const cachedBalances = cached?.lastTokenSnapshot?.balances || [];
        if (cachedBalances.length) {
            console.warn('[portfolio-heartbeat][relayer][balance] returning cached token snapshot', {
                address: String(address || '').trim(),
                cachedAt: cached?.lastTokenSnapshot?.updatedAt || null,
                count: cachedBalances.length,
                reason: errorMessage,
            });
            return cachedBalances;
        }
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
            mappedRpc: 'tl_watchonly_register',
        });

        const normalizedAddress = String(address || '').trim();
        const normalizedPubkey = String(pubkey || '').trim();
        const providerNodeId = await resolveWatchOnlyProviderNodeId(normalizedAddress);
        const allocatedRes = await callAllocatedRpc('tl_watchonly_register', [{
            address: normalizedAddress,
            pubkey: normalizedPubkey,
            network: envConfig.COLLATOR_RPC_NETWORK || envConfig.NETWORK,
        }], {
            preferredProviderNodeId: providerNodeId,
            service: envConfig.COLLATOR_RPC_SERVICE,
            network: envConfig.COLLATOR_RPC_NETWORK || envConfig.NETWORK,
        });
        const res = await upsertWatchOnlyAccounts([
            { address: normalizedAddress, pubkey: normalizedPubkey },
        ], {
            source: 'sync-watchonly',
            skipWalletRpc: true,
            imported: !allocatedRes.error,
        });
        const first = res.results[0];
        if (first?.error) throw new Error(first.error);

        if (allocatedRes.error) {
            console.warn('[portfolio-heartbeat][relayer][watchonly-import] collator-import-failed', {
                address: normalizedAddress,
                providerNodeId: providerNodeId || null,
                error: allocatedRes.error,
            });
            return { error: allocatedRes.error };
        }

        console.log('[portfolio-heartbeat][relayer][watchonly-import] response', {
            address: normalizedAddress,
            imported: !!first?.imported,
            skipped: !!first?.skipped,
            refreshed: !!first?.refreshed,
            updated: !!first?.updated,
            providerNodeId: allocatedRes.providerNodeId || providerNodeId || null,
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
            mappedRpc: 'tl_watchonly_register',
        });
        const registered = [] as WatchOnlyAccount[];
        const failures: Array<{ address: string; pubkey: string; error: string }> = [];
        for (const account of accounts || []) {
            const address = String(account?.address || '').trim();
            const pubkey = String(account?.pubkey || '').trim();
            const result = await importPubKey(_server, [pubkey, address]);
            if (result.error) failures.push({ address, pubkey, error: result.error });
            else registered.push({ address, pubkey });
        }
        const res = await upsertWatchOnlyAccounts(registered, {
            source: 'sync-watchonly',
            skipWalletRpc: true,
            imported: true,
        });

        console.log('[portfolio-heartbeat][relayer][watchonly-sync] response', {
            imported: res.imported,
            refreshed: res.refreshed,
            skipped: res.skipped,
            updated: res.updated,
            failed: res.failed + failures.length,
        });

        return {
            data: {
                imported: res.imported,
                skipped: res.skipped,
                refreshed: res.refreshed,
                updated: res.updated,
                failed: res.failed + failures.length,
                snapshot: res.snapshot,
                results: [
                    ...res.results.map((item) => ({
                    address: item.address,
                    imported: item.imported,
                    error: item.error,
                    })),
                    ...failures.map((item) => ({ address: item.address, imported: false, error: item.error })),
                ],
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
