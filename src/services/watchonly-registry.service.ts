import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { envConfig } from '../config/env.config';
import { rpcClient } from '../config/rpc.config';
import { ELogType, saveLog } from './utils.service';

export interface WatchOnlyAccount {
    address: string;
    pubkey: string;
}

export interface WatchOnlyRegistryEntry extends WatchOnlyAccount {
    source: string;
    assignedProviderNodeId?: string | null;
    assignedAt?: number | null;
    firstSeenAt: number;
    firstFundingHeight?: number | null;
    firstFundingTxid?: string | null;
    lastSeenAt: number;
    lastImportedAt: number | null;
    importCount: number;
    scanState?: 'new' | 'imported' | 'backfilled' | 'live' | 'stale';
    lastScannedAt?: number | null;
    lastScannedHeight?: number | null;
    scanSourceNodeId?: string | null;
    lastSnapshotHeight?: number | null;
    lastError?: string;
    lastUtxoSnapshot?: {
        hash: string;
        count: number;
        totalAmount: number;
        updatedAt: number;
        scannedHeight?: number | null;
        scanSourceNodeId?: string | null;
        utxos: Array<{
            txid: string;
            vout: number;
            amount: number;
            confirmations: number;
            scriptPubKey?: string;
        }>;
    };
    lastTokenSnapshot?: {
        updatedAt: number;
        scannedHeight?: number | null;
        scanSourceNodeId?: string | null;
        balances: Array<{
            propertyId: string | number;
            ticker?: string;
            amount: number;
            available: number;
            reserved: number;
            margin: number;
            vesting: number;
            channel: number;
        }>;
    };
}

export interface WatchOnlyRegistrySnapshot {
    path: string;
    generatedAt: number;
    entries: WatchOnlyRegistryEntry[];
}

export interface WatchOnlyImportResult {
    address: string;
    pubkey: string;
    imported: boolean;
    refreshed: boolean;
    skipped: boolean;
    updated: boolean;
    error?: string;
}

export interface WatchOnlyScanCoverage {
    address: string;
    pubkey?: string;
    firstFundingHeight?: number | null;
    firstFundingTxid?: string | null;
    currentTipHeight: number | null;
    lastScannedHeight: number | null;
    lastSnapshotHeight: number | null;
    scanState: WatchOnlyRegistryEntry['scanState'];
    needsRescan: boolean;
    reason: string;
}

export interface WatchOnlySyncSummary {
    imported: number;
    refreshed: number;
    skipped: number;
    updated: number;
    failed: number;
    results: WatchOnlyImportResult[];
    snapshot: WatchOnlyRegistrySnapshot;
}

const DEFAULT_REGISTRY_PATH = 'state/watchonly-registry.json';
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

let registryCache: Map<string, WatchOnlyRegistryEntry> | null = null;
let registryLoadPromise: Promise<Map<string, WatchOnlyRegistryEntry>> | null = null;
let reconcileInFlight = false;

const PORTFOLIO_HEARTBEAT_METHODS = new Set([
    'getaddressinfo',
    'getblockchaininfo',
    'importpubkey',
    'listunspent',
    'tl_getallbalancesforaddress',
]);

function trimSlash(value: string): string {
    return String(value || '').replace(/\/+$/, '');
}

function useCollatorRpc(): boolean {
    return !!String(envConfig.COLLATOR_URL || '').trim();
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
            mappedAction: 'watchonly-registry-add',
        };
    }

    if (
        normalizedMethod === 'getaddressinfo' ||
        normalizedMethod === 'tl_getallbalancesforaddress' ||
        normalizedMethod === 'tl_listproperties' ||
        normalizedMethod === 'tl_getproperty'
    ) {
        return { address: String(first || '').trim() };
    }

    return { paramsCount: params.length };
}

async function callRpc(method: string, ...params: any[]): Promise<{ data?: any; error?: string; providerNodeId?: string }> {
    if (!useCollatorRpc()) {
        return rpcClient.call(method, ...params);
    }

    try {
        const url = trimSlash(envConfig.COLLATOR_URL);
        if (isPortfolioHeartbeatRpc(method)) {
            console.log('[portfolio-heartbeat][relayer][registry-rpc] request', {
                method,
                service: envConfig.COLLATOR_RPC_SERVICE,
                network: envConfig.COLLATOR_RPC_NETWORK || null,
                route: '/rpc/route',
                sourceEndpoint: 'testnet-api',
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
            },
            { timeout: 15000 },
        );

        const payload: any = res.data || {};
        if (payload.ok === false) {
            if (isPortfolioHeartbeatRpc(method)) {
                console.warn('[portfolio-heartbeat][relayer][registry-rpc] failure', {
                    method,
                    error: payload?.error?.message || payload?.error || 'Collator RPC failed',
                });
            }
            return { error: payload?.error?.message || payload?.error || 'Collator RPC failed' };
        }

        if (isPortfolioHeartbeatRpc(method)) {
            console.log('[portfolio-heartbeat][relayer][registry-rpc] response', {
                method,
                hasData: payload?.result != null || payload?.data != null,
                providerNodeId: payload?.providerNodeId || null,
            });
        }
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
        if (isPortfolioHeartbeatRpc(method)) {
            console.warn('[portfolio-heartbeat][relayer][registry-rpc] error', {
                method,
                message,
            });
        }
        return { error: message };
    }
}

function getRegistryPath(): string {
    return String(envConfig.WATCHONLY_REGISTRY_PATH || DEFAULT_REGISTRY_PATH).trim() || DEFAULT_REGISTRY_PATH;
}

function normalize(value: string): string {
    return String(value || '').trim();
}

function normalizeHeight(value: any): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeTxid(value: any): string | null {
    const txid = normalize(String(value || ''));
    return txid || null;
}

function normalizeTokenBalance(balance: any) {
    if (!balance || typeof balance !== 'object') return null;
    const propertyId = balance.propertyId != null ? String(balance.propertyId) : '';
    if (!propertyId) return null;
    return {
        propertyId,
        ticker: balance.ticker == null ? undefined : String(balance.ticker),
        amount: Number(balance.amount || 0),
        available: Number(balance.available || 0),
        reserved: Number(balance.reserved || 0),
        margin: Number(balance.margin || 0),
        vesting: Number(balance.vesting || 0),
        channel: Number(balance.channel || 0),
    };
}

function normalizeAccount(account: Partial<WatchOnlyAccount> | null | undefined): WatchOnlyAccount | null {
    const address = normalize(String(account?.address || ''));
    const pubkey = normalize(String(account?.pubkey || ''));
    if (!address || !pubkey) return null;
    return { address, pubkey };
}

function toEntry(raw: any): WatchOnlyRegistryEntry | null {
    const account = normalizeAccount(raw);
    if (!account) return null;

    const now = Date.now();
    const firstSeenAt = Number(raw?.firstSeenAt);
    const firstFundingHeight = normalizeHeight(raw?.firstFundingHeight);
    const firstFundingTxid = normalizeTxid(raw?.firstFundingTxid);
    const lastSeenAt = Number(raw?.lastSeenAt);
    const lastImportedAt = Number(raw?.lastImportedAt);
    const importCount = Number(raw?.importCount);
    const assignedAt = Number(raw?.assignedAt);
    const lastScannedAt = Number(raw?.lastScannedAt);
    const lastScannedHeight = normalizeHeight(raw?.lastScannedHeight);
    const lastSnapshotHeight = normalizeHeight(raw?.lastSnapshotHeight);
    const scanStateRaw = String(raw?.scanState || '').trim().toLowerCase();
    const scanState = ['new', 'imported', 'backfilled', 'live', 'stale'].includes(scanStateRaw)
        ? (scanStateRaw as WatchOnlyRegistryEntry['scanState'])
        : undefined;

    const lastUtxoSnapshot = raw?.lastUtxoSnapshot && typeof raw.lastUtxoSnapshot === 'object'
        ? {
            hash: String(raw.lastUtxoSnapshot.hash || ''),
            count: Number(raw.lastUtxoSnapshot.count || 0),
            totalAmount: Number(raw.lastUtxoSnapshot.totalAmount || 0),
            updatedAt: Number(raw.lastUtxoSnapshot.updatedAt || now),
            scannedHeight: normalizeHeight(raw.lastUtxoSnapshot.scannedHeight),
            scanSourceNodeId: raw.lastUtxoSnapshot.scanSourceNodeId == null ? undefined : String(raw.lastUtxoSnapshot.scanSourceNodeId),
            utxos: Array.isArray(raw.lastUtxoSnapshot.utxos) ? raw.lastUtxoSnapshot.utxos : [],
        }
        : undefined;
    const lastTokenSnapshot = raw?.lastTokenSnapshot && typeof raw.lastTokenSnapshot === 'object'
        ? {
            updatedAt: Number(raw.lastTokenSnapshot.updatedAt || now),
            scannedHeight: normalizeHeight(raw.lastTokenSnapshot.scannedHeight),
            scanSourceNodeId: raw.lastTokenSnapshot.scanSourceNodeId == null ? undefined : String(raw.lastTokenSnapshot.scanSourceNodeId),
            balances: Array.isArray(raw.lastTokenSnapshot.balances)
                ? raw.lastTokenSnapshot.balances.map(normalizeTokenBalance).filter(Boolean)
                : [],
        }
        : undefined;

    return {
        address: account.address,
        pubkey: account.pubkey,
        source: normalize(String(raw?.source || 'sync-watchonly')) || 'sync-watchonly',
        ...(raw?.assignedProviderNodeId == null ? {} : { assignedProviderNodeId: String(raw.assignedProviderNodeId) }),
        ...(Number.isFinite(assignedAt) && assignedAt > 0 ? { assignedAt } : {}),
        firstSeenAt: Number.isFinite(firstSeenAt) && firstSeenAt > 0 ? firstSeenAt : now,
        ...(firstFundingHeight != null ? { firstFundingHeight } : {}),
        ...(firstFundingTxid ? { firstFundingTxid } : {}),
        lastSeenAt: Number.isFinite(lastSeenAt) && lastSeenAt > 0 ? lastSeenAt : now,
        lastImportedAt: Number.isFinite(lastImportedAt) && lastImportedAt > 0 ? lastImportedAt : null,
        importCount: Number.isFinite(importCount) && importCount >= 0 ? importCount : 0,
        ...(scanState ? { scanState } : {}),
        ...(Number.isFinite(lastScannedAt) && lastScannedAt > 0 ? { lastScannedAt } : {}),
        ...(lastScannedHeight != null ? { lastScannedHeight } : {}),
        ...(lastSnapshotHeight != null ? { lastSnapshotHeight } : {}),
        ...(raw?.scanSourceNodeId == null ? {} : { scanSourceNodeId: String(raw.scanSourceNodeId) }),
        ...(typeof raw?.lastError === 'string' && raw.lastError.trim() ? { lastError: raw.lastError.trim() } : {}),
        ...(lastUtxoSnapshot ? { lastUtxoSnapshot } : {}),
        ...(lastTokenSnapshot ? { lastTokenSnapshot } : {}),
    };
}

function snapshotFromEntries(entries: Map<string, WatchOnlyRegistryEntry>): WatchOnlyRegistrySnapshot {
    return {
        path: getRegistryPath(),
        generatedAt: Date.now(),
        entries: Array.from(entries.values()).sort((a, b) => a.address.localeCompare(b.address)),
    };
}

async function loadRegistryFromDisk(): Promise<Map<string, WatchOnlyRegistryEntry>> {
    const registryPath = getRegistryPath();
    try {
        if (!fs.existsSync(registryPath)) {
            return new Map();
        }

        const raw = await fs.promises.readFile(registryPath, 'utf8');
        if (!raw.trim()) {
            return new Map();
        }

        const parsed = JSON.parse(raw);
        const sourceEntries = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.entries)
                ? parsed.entries
                : Array.isArray(parsed?.accounts)
                    ? parsed.accounts
                    : [];

        const entries = new Map<string, WatchOnlyRegistryEntry>();
        for (const item of sourceEntries) {
            const entry = toEntry(item);
            if (!entry) continue;
            entries.set(entry.address, entry);
        }
        return entries;
    } catch (error) {
        console.warn(`[watchonly-registry] Failed to load ${registryPath}:`, (error as Error)?.message || error);
        return new Map();
    }
}

async function getRegistryEntries(): Promise<Map<string, WatchOnlyRegistryEntry>> {
    if (registryCache) return registryCache;
    if (!registryLoadPromise) {
        registryLoadPromise = loadRegistryFromDisk().then((entries) => {
            registryCache = entries;
            registryLoadPromise = null;
            return entries;
        }).catch((error) => {
            registryLoadPromise = null;
            throw error;
        });
    }
    return registryLoadPromise;
}

async function persistRegistryEntries(entries: Map<string, WatchOnlyRegistryEntry>): Promise<void> {
    const registryPath = getRegistryPath();
    const snapshot = snapshotFromEntries(entries);
    const dir = path.dirname(registryPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        try {
            await fs.promises.rename(tmpPath, registryPath);
        } catch (renameError: any) {
            const message = String(renameError?.message || renameError || '').toLowerCase();
            if (message.includes('enoent')) {
                await fs.promises.writeFile(registryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
            } else {
                throw renameError;
            }
        }
        registryCache = entries;
    } finally {
        await fs.promises.unlink(tmpPath).catch(() => undefined);
    }
}

async function upsertWatchOnlyRegistryEntries(
    entries: Array<Partial<WatchOnlyRegistryEntry>>,
    options?: { source?: string; refresh?: boolean },
): Promise<WatchOnlySyncSummary> {
    const registry = await getRegistryEntries();
    const now = Date.now();
    const results: WatchOnlyImportResult[] = [];
    let imported = 0;
    let refreshed = 0;
    let skipped = 0;
    let updated = 0;
    let failed = 0;

    for (const raw of entries || []) {
        const entry = toEntry(raw);
        if (!entry) {
            failed += 1;
            results.push({
                address: String(raw?.address || '').trim(),
                pubkey: String(raw?.pubkey || '').trim(),
                imported: false,
                refreshed: false,
                skipped: false,
                updated: false,
                error: 'Invalid watch-only entry',
            });
            continue;
        }

        const existing = registry.get(entry.address);
        const merged: WatchOnlyRegistryEntry = {
            ...(existing || entry),
            ...entry,
            source: options?.source || entry.source || existing?.source || 'bootstrap',
            assignedProviderNodeId: entry.assignedProviderNodeId ?? entry.scanSourceNodeId ?? existing?.assignedProviderNodeId ?? null,
            assignedAt: normalizeHeight(entry.assignedAt) ?? existing?.assignedAt ?? null,
            firstSeenAt: existing?.firstSeenAt || entry.firstSeenAt || now,
            firstFundingHeight: normalizeHeight(entry.firstFundingHeight) ?? existing?.firstFundingHeight ?? null,
            firstFundingTxid: normalizeTxid(entry.firstFundingTxid) ?? existing?.firstFundingTxid ?? null,
            lastSeenAt: now,
            lastImportedAt: entry.lastImportedAt ?? existing?.lastImportedAt ?? null,
            importCount: Number.isFinite(Number(entry.importCount)) ? Number(entry.importCount) : (existing?.importCount ?? 0),
            scanState: entry.scanState || existing?.scanState || 'imported',
            lastScannedAt: entry.lastScannedAt ?? existing?.lastScannedAt ?? null,
            lastScannedHeight: normalizeHeight(entry.lastScannedHeight) ?? existing?.lastScannedHeight ?? null,
            scanSourceNodeId: entry.scanSourceNodeId ?? existing?.scanSourceNodeId ?? null,
            lastSnapshotHeight: normalizeHeight(entry.lastSnapshotHeight) ?? existing?.lastSnapshotHeight ?? null,
            ...(entry.lastError || existing?.lastError ? { lastError: entry.lastError || existing?.lastError } : {}),
            ...(entry.lastUtxoSnapshot || existing?.lastUtxoSnapshot
                ? { lastUtxoSnapshot: entry.lastUtxoSnapshot || existing?.lastUtxoSnapshot }
                : {}),
            ...(entry.lastTokenSnapshot || existing?.lastTokenSnapshot
                ? { lastTokenSnapshot: entry.lastTokenSnapshot || existing?.lastTokenSnapshot }
                : {}),
        };

        registry.set(entry.address, merged);
        results.push({
            address: entry.address,
            pubkey: entry.pubkey,
            imported: !existing,
            refreshed: !!existing,
            skipped: !!existing,
            updated: true,
        });
        if (existing) {
            refreshed += 1;
            skipped += 1;
        } else {
            imported += 1;
        }
        updated += 1;
    }

    await persistRegistryEntries(registry).catch((error) => {
        console.warn('[watchonly-registry] persist skipped after batch upsert:', (error as Error)?.message || error);
    });
    const snapshot = snapshotFromEntries(registry);
    return {
        imported,
        refreshed,
        skipped,
        updated,
        failed,
        results,
        snapshot,
    };
}

export async function bootstrapWatchOnlyRegistryFromSeed(input?: {
    sourceUrl?: string;
    network?: string;
    force?: boolean;
}) {
    const sourceUrl = trimSlash(String(input?.sourceUrl || envConfig.WATCHONLY_REGISTRY_SEED_URL || ''));
    if (!sourceUrl) {
        return {
            imported: 0,
            refreshed: 0,
            skipped: 0,
            updated: 0,
            failed: 0,
            results: [],
            snapshot: await loadWatchOnlyRegistrySnapshot(),
            sourceUrl: null,
        };
    }

    const current = await loadWatchOnlyRegistrySnapshot();
    if (!input?.force && current.entries.length > 0) {
        return {
            imported: 0,
            refreshed: 0,
            skipped: current.entries.length,
            updated: 0,
            failed: 0,
            results: [],
            snapshot: current,
            sourceUrl,
        };
    }

    const url = input?.network
        ? `${sourceUrl}/address/watchonly?network=${encodeURIComponent(String(input.network))}`
        : `${sourceUrl}/address/watchonly`;

    const response = await axios.get(url, { timeout: 15_000 });
    const payload: any = response.data || {};
    const entries = Array.isArray(payload?.entries)
        ? payload.entries
        : Array.isArray(payload)
            ? payload
            : [];

    const imported = await upsertWatchOnlyRegistryEntries(entries, { source: `bootstrap:${sourceUrl}` });
    return {
        ...imported,
        sourceUrl,
    };
}

async function alreadyImported(address: string): Promise<boolean> {
    const addressInfo = await callRpc('getaddressinfo', address);
    return !!addressInfo?.data?.ismine || !!addressInfo?.data?.iswatchonly;
}

async function getCurrentChainHeight(): Promise<number | null> {
    const chainInfo = await callRpc('getblockchaininfo');
    const height = chainInfo?.data?.blocks ?? chainInfo?.data?.result?.blocks;
    return normalizeHeight(height);
}

async function importWatchOnlyAccount(
    account: WatchOnlyAccount,
    options?: { source?: string; refresh?: boolean },
): Promise<WatchOnlyImportResult> {
    const normalized = normalizeAccount(account);
    if (!normalized) {
        return {
            address: String(account?.address || '').trim(),
            pubkey: String(account?.pubkey || '').trim(),
            imported: false,
            refreshed: false,
            skipped: false,
            updated: false,
            error: 'Invalid watch-only account',
        };
    }

    const entries = await getRegistryEntries();
    const now = Date.now();
    const existing = entries.get(normalized.address);
    const samePubkey = existing?.pubkey === normalized.pubkey;
    const refreshRequested = !!options?.refresh;
    const registryMatched = !!existing && samePubkey;

    if (registryMatched && existing?.lastImportedAt && !refreshRequested) {
        const nextEntry: WatchOnlyRegistryEntry = {
            ...existing,
            lastSeenAt: now,
            source: options?.source || existing.source || 'sync-watchonly',
        };
        entries.set(normalized.address, nextEntry);
        await persistRegistryEntries(entries).catch((error) => {
            console.warn('[watchonly-registry] persist skipped after registry-matched refresh:', (error as Error)?.message || error);
        });
        return {
            address: normalized.address,
            pubkey: normalized.pubkey,
            imported: false,
            refreshed: false,
            skipped: true,
            updated: true,
        };
    }

    const nextEntry: WatchOnlyRegistryEntry = {
        address: normalized.address,
        pubkey: normalized.pubkey,
        source: options?.source || existing?.source || 'sync-watchonly',
        assignedProviderNodeId: existing?.assignedProviderNodeId ?? existing?.scanSourceNodeId ?? null,
        assignedAt: existing?.assignedAt ?? null,
        firstSeenAt: existing?.firstSeenAt || now,
        firstFundingHeight: existing?.firstFundingHeight ?? null,
        firstFundingTxid: existing?.firstFundingTxid ?? null,
        lastSeenAt: now,
        lastImportedAt: existing?.lastImportedAt ?? null,
        importCount: existing?.importCount ?? 0,
        scanState: existing?.scanState || 'imported',
        lastScannedAt: existing?.lastScannedAt ?? null,
        lastScannedHeight: existing?.lastScannedHeight ?? null,
        scanSourceNodeId: existing?.scanSourceNodeId ?? null,
        lastSnapshotHeight: existing?.lastSnapshotHeight ?? null,
        ...(existing?.lastError ? { lastError: existing.lastError } : {}),
    };

    try {
        console.log('[portfolio-heartbeat][relayer][registry] import-request', {
            address: normalized.address,
            source: options?.source || existing?.source || 'sync-watchonly',
            refreshRequested,
            alreadyTracked: !!existing,
            pubkey: normalized.pubkey,
            mappedRpc: 'importpubkey',
        });
        const importedAlready = await alreadyImported(normalized.address);
        if (!importedAlready) {
            const importRes = await callRpc('importpubkey', normalized.pubkey, 'default', false);
            if (importRes.error) {
                nextEntry.lastError = importRes.error;
                entries.set(normalized.address, nextEntry);
                await persistRegistryEntries(entries).catch((error) => {
                    console.warn('[watchonly-registry] persist skipped after import error:', (error as Error)?.message || error);
                });
                return {
                    address: normalized.address,
                    pubkey: normalized.pubkey,
                    imported: false,
                    refreshed: false,
                    skipped: false,
                    updated: true,
                    error: importRes.error,
                };
            }
            saveLog(ELogType.PUBKEYS, normalized.pubkey);
            nextEntry.importCount += 1;
            if (importRes.providerNodeId) {
                nextEntry.assignedProviderNodeId = importRes.providerNodeId;
                nextEntry.assignedAt = now;
            }
            console.log('[portfolio-heartbeat][relayer][registry] import-complete', {
                address: normalized.address,
                imported: true,
                providerNodeId: importRes.providerNodeId || null,
                pubkey: normalized.pubkey,
                assignedProviderNodeId: nextEntry.assignedProviderNodeId || null,
            });
        } else {
            nextEntry.importCount = existing?.importCount ?? 0;
            console.log('[portfolio-heartbeat][relayer][registry] import-skipped', {
                address: normalized.address,
                reason: 'already-imported',
            });
        }

        nextEntry.lastImportedAt = now;
        nextEntry.scanState = nextEntry.scanState || 'imported';
        delete nextEntry.lastError;
        entries.set(normalized.address, nextEntry);
        await persistRegistryEntries(entries).catch((error) => {
            console.warn('[watchonly-registry] persist skipped after successful import:', (error as Error)?.message || error);
        });

        return {
            address: normalized.address,
            pubkey: normalized.pubkey,
            imported: !importedAlready,
            refreshed: importedAlready,
            skipped: importedAlready,
            updated: !registryMatched || !samePubkey,
        };
    } catch (error: any) {
        const message = error?.message || 'Failed to import watch-only account';
        nextEntry.lastError = message;
        entries.set(normalized.address, nextEntry);
        await persistRegistryEntries(entries).catch((persistError) => {
            console.warn('[watchonly-registry] persist skipped after import failure:', (persistError as Error)?.message || persistError);
        });
        return {
            address: normalized.address,
            pubkey: normalized.pubkey,
            imported: false,
            refreshed: false,
            skipped: false,
            updated: true,
            error: message,
        };
    }
}

export async function resolveWatchOnlyPubkey(address: string): Promise<string | undefined> {
    const entries = await getRegistryEntries();
    return entries.get(normalize(address))?.pubkey;
}

export async function getWatchOnlyCoverage(address: string): Promise<WatchOnlyScanCoverage | null> {
    const entries = await getRegistryEntries();
    const entry = entries.get(normalize(address));
    if (!entry) return null;

    const currentTipHeight = await getCurrentChainHeight();
    const firstFundingHeight = normalizeHeight(entry.firstFundingHeight);
    const firstFundingTxid = normalizeTxid(entry.firstFundingTxid);
    const lastScannedHeight = normalizeHeight(entry.lastScannedHeight);
    const lastSnapshotHeight = normalizeHeight(entry.lastSnapshotHeight);
    const coveredHeight = lastSnapshotHeight ?? lastScannedHeight;
    const needsRescan = currentTipHeight == null
        ? coveredHeight == null
        : coveredHeight == null || coveredHeight < currentTipHeight;

    return {
        address: entry.address,
        pubkey: entry.pubkey,
        firstFundingHeight,
        firstFundingTxid,
        currentTipHeight,
        lastScannedHeight,
        lastSnapshotHeight,
        scanState: entry.scanState || 'imported',
        needsRescan,
        reason: !entry.lastImportedAt
            ? 'not imported'
            : firstFundingHeight != null && coveredHeight == null
                ? 'scan coverage can start at first funding height'
            : needsRescan
                ? 'scan coverage is stale'
                : 'scan coverage is current',
    };
}

export function resolveWatchOnlyRescanStartHeight(entry?: Partial<WatchOnlyRegistryEntry> | null): number | null {
    const candidates = [
        normalizeHeight(entry?.firstFundingHeight),
        normalizeHeight(entry?.lastSnapshotHeight),
        normalizeHeight(entry?.lastScannedHeight),
    ].filter((value): value is number => Number.isFinite(Number(value)) && Number(value) >= 0);

    if (!candidates.length) return null;
    return Math.max(0, Math.min(...candidates));
}

export async function loadWatchOnlyRegistrySnapshot(): Promise<WatchOnlyRegistrySnapshot> {
    const entries = await getRegistryEntries();
    return snapshotFromEntries(entries);
}

export async function getWatchOnlyRegistryEntry(address: string): Promise<WatchOnlyRegistryEntry | null> {
    const entries = await getRegistryEntries();
    return entries.get(normalize(address)) || null;
}

export async function listWatchOnlyEntries(input?: { network?: string; address?: string }) {
    const snapshot = await loadWatchOnlyRegistrySnapshot();
    const network = normalize(input?.network || envConfig.NETWORK || '').toLowerCase();
    const address = normalize(input?.address || '');

    return snapshot.entries.filter((entry) => {
        const entryNetwork = normalize(envConfig.NETWORK || '').toLowerCase();
        if (network && entryNetwork && network !== entryNetwork) {
            return false;
        }
        if (address && entry.address !== address) {
            return false;
        }
        return true;
    });
}

export async function getWatchOnlyRegistrySummary() {
    const snapshot = await loadWatchOnlyRegistrySnapshot();
    return {
        version: 1,
        updatedAt: snapshot.generatedAt,
        entryCount: snapshot.entries.length,
        entries: snapshot.entries,
    };
}

export async function upsertWatchOnlyEntry(input: {
    network?: string;
    address: string;
    pubkey: string;
    imported?: boolean;
    importError?: string | null;
}) {
    const summary = await upsertWatchOnlyAccounts(
        [{ address: input.address, pubkey: input.pubkey }],
        { source: 'manual-upsert', refresh: !!input.imported }
    );
    return summary.results[0] || null;
}

export async function markWatchOnlyScanCoverage(input: {
    network?: string;
    address: string;
    pubkey?: string;
    firstFundingHeight?: number | null;
    firstFundingTxid?: string | null;
    scannedHeight?: number | null;
    scanSourceNodeId?: string | null;
    scanState?: WatchOnlyRegistryEntry['scanState'];
}) {
    return recordWatchOnlySnapshot({
        network: input.network,
        address: input.address,
        pubkey: input.pubkey,
        utxos: [],
        firstFundingHeight: input.firstFundingHeight ?? null,
        firstFundingTxid: input.firstFundingTxid ?? null,
        scannedHeight: input.scannedHeight,
        scanSourceNodeId: input.scanSourceNodeId,
        scanState: input.scanState || 'backfilled',
    });
}

function normalizeSnapshotUtxo(utxo: any) {
    if (!utxo || typeof utxo !== 'object') return null;
    const txid = normalize(String(utxo.txid || ''));
    const vout = Number(utxo.vout);
    if (!txid || !Number.isInteger(vout)) return null;
    return {
        txid,
        vout,
        amount: Number(utxo.amount || 0),
        confirmations: Number(utxo.confirmations || 0),
        scriptPubKey: utxo.scriptPubKey == null ? undefined : String(utxo.scriptPubKey),
    };
}

function computeSnapshotHash(utxos: Array<ReturnType<typeof normalizeSnapshotUtxo>>) {
    const canonical = (utxos || []).filter(Boolean).slice().sort((a, b) => {
        if (a.txid === b.txid) {
            return a.vout - b.vout;
        }
        return a.txid.localeCompare(b.txid);
    });
    return require('crypto').createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function recordWatchOnlySnapshot(input: {
    network?: string;
    address: string;
    pubkey?: string;
    utxos: any[];
    firstFundingHeight?: number | null;
    firstFundingTxid?: string | null;
    scannedHeight?: number | null;
    scanSourceNodeId?: string | null;
    scanState?: WatchOnlyRegistryEntry['scanState'];
}) {
    const registry = await getRegistryEntries();
    const now = Date.now();
    const address = normalize(input.address);
    const network = normalize(input.network || envConfig.NETWORK || '').toLowerCase();
    const pubkey = normalize(input.pubkey || '');
    if (!address || !pubkey) {
        return null;
    }

    const key = address;
    const existing = registry.get(key) || {
        address,
        pubkey,
        source: 'snapshot',
        firstSeenAt: now,
        lastSeenAt: now,
        lastImportedAt: null,
        importCount: 0,
    } as WatchOnlyRegistryEntry;

    const utxos = (Array.isArray(input.utxos) ? input.utxos : [])
        .map(normalizeSnapshotUtxo)
        .filter(Boolean);

    console.log('[portfolio-heartbeat][relayer][registry] snapshot', {
        address,
        count: utxos.length,
        network,
        scanSourceNodeId: input.scanSourceNodeId || existing.scanSourceNodeId || null,
        scanState: input.scanState || existing.scanState || 'live',
    });

    const next: WatchOnlyRegistryEntry = {
        ...existing,
        address,
        pubkey,
        source: existing.source || 'snapshot',
        assignedProviderNodeId: existing.assignedProviderNodeId ?? input.scanSourceNodeId ?? null,
        assignedAt: existing.assignedAt ?? null,
        firstSeenAt: existing.firstSeenAt || now,
        firstFundingHeight: normalizeHeight(input.firstFundingHeight) ?? existing.firstFundingHeight ?? null,
        firstFundingTxid: normalizeTxid(input.firstFundingTxid) ?? existing.firstFundingTxid ?? null,
        lastSeenAt: now,
        scanState: input.scanState || existing.scanState || 'live',
        lastScannedAt: now,
        lastScannedHeight: normalizeHeight(input.scannedHeight) ?? existing.lastScannedHeight ?? null,
        lastSnapshotHeight: normalizeHeight(input.scannedHeight) ?? existing.lastSnapshotHeight ?? null,
        scanSourceNodeId: input.scanSourceNodeId || existing.scanSourceNodeId || null,
        lastUtxoSnapshot: {
            hash: computeSnapshotHash(utxos),
            count: utxos.length,
            totalAmount: utxos.reduce((sum, item) => sum + Number(item.amount || 0), 0),
            updatedAt: now,
            scannedHeight: normalizeHeight(input.scannedHeight),
            scanSourceNodeId: input.scanSourceNodeId || existing.scanSourceNodeId || null,
            utxos,
        },
    };

    registry.set(key, next);
    await persistRegistryEntries(registry).catch((error) => {
        console.warn('[watchonly-registry] persist skipped after snapshot:', (error as Error)?.message || error);
    });
    return next;
}

export async function recordWatchOnlyTokenSnapshot(input: {
    network?: string;
    address: string;
    pubkey?: string;
    balances: Array<{
        propertyId: string | number;
        ticker?: string;
        amount: number;
        available: number;
        reserved: number;
        margin: number;
        vesting: number;
        channel: number;
    }>;
    scannedHeight?: number | null;
    scanSourceNodeId?: string | null;
}) {
    const registry = await getRegistryEntries();
    const now = Date.now();
    const address = normalize(input.address);
    const pubkey = normalize(input.pubkey || '');
    if (!address) return null;

    const existing = registry.get(address) || {
        address,
        pubkey: pubkey || '',
        source: 'snapshot',
        firstSeenAt: now,
        lastSeenAt: now,
        lastImportedAt: null,
        importCount: 0,
    } as WatchOnlyRegistryEntry;

    const balances = (Array.isArray(input.balances) ? input.balances : [])
        .map(normalizeTokenBalance)
        .filter(Boolean);

    const next: WatchOnlyRegistryEntry = {
        ...existing,
        address,
        pubkey: pubkey || existing.pubkey,
        source: existing.source || 'snapshot',
        lastSeenAt: now,
        lastTokenSnapshot: {
            updatedAt: now,
            scannedHeight: normalizeHeight(input.scannedHeight),
            scanSourceNodeId: input.scanSourceNodeId || existing.scanSourceNodeId || null,
            balances,
        },
    };

    registry.set(address, next);
    await persistRegistryEntries(registry).catch((error) => {
        console.warn('[watchonly-registry] persist skipped after token snapshot:', (error as Error)?.message || error);
    });
    return next;
}

export async function upsertWatchOnlyAccounts(
    accounts: WatchOnlyAccount[],
    options?: { source?: string; refresh?: boolean },
): Promise<WatchOnlySyncSummary> {
    const results: WatchOnlyImportResult[] = [];
    let imported = 0;
    let refreshed = 0;
    let skipped = 0;
    let updated = 0;
    let failed = 0;

    const seen = new Set<string>();
    for (const account of accounts || []) {
        const normalized = normalizeAccount(account);
        if (!normalized) {
            failed += 1;
            results.push({
                address: String(account?.address || '').trim(),
                pubkey: String(account?.pubkey || '').trim(),
                imported: false,
                refreshed: false,
                skipped: false,
                updated: false,
                error: 'Invalid watch-only account',
            });
            continue;
        }

        const dedupeKey = `${normalized.address}|${normalized.pubkey}`;
        if (seen.has(dedupeKey)) {
            skipped += 1;
            results.push({
                address: normalized.address,
                pubkey: normalized.pubkey,
                imported: false,
                refreshed: false,
                skipped: true,
                updated: false,
            });
            continue;
        }
        seen.add(dedupeKey);

        const res = await importWatchOnlyAccount(normalized, options);
        results.push(res);

        if (res.error) {
            failed += 1;
        } else if (res.imported) {
            imported += 1;
        } else if (res.refreshed) {
            refreshed += 1;
        } else if (res.skipped) {
            skipped += 1;
        }

        if (res.updated) {
            updated += 1;
        }
    }

    const snapshot = await loadWatchOnlyRegistrySnapshot();
    return {
        imported,
        refreshed,
        skipped,
        updated,
        failed,
        results,
        snapshot,
    };
}

export async function reconcileWatchOnlyRegistry(): Promise<WatchOnlySyncSummary> {
    const snapshot = await loadWatchOnlyRegistrySnapshot();
    const results: WatchOnlyImportResult[] = [];
    let imported = 0;
    let refreshed = 0;
    let skipped = 0;
    let updated = 0;
    let failed = 0;

    for (const entry of snapshot.entries) {
        const res = await importWatchOnlyAccount(
            { address: entry.address, pubkey: entry.pubkey },
            { source: 'reconcile', refresh: true },
        );
        results.push(res);

        if (res.error) {
            failed += 1;
        } else if (res.imported) {
            imported += 1;
        } else if (res.refreshed) {
            refreshed += 1;
        } else if (res.skipped) {
            skipped += 1;
        }

        if (res.updated) {
            updated += 1;
        }
    }

    const nextSnapshot = await loadWatchOnlyRegistrySnapshot();
    return {
        imported,
        refreshed,
        skipped,
        updated,
        failed,
        results,
        snapshot: nextSnapshot,
    };
}

export function startWatchOnlyRegistryReconciliation(intervalMs = Number(envConfig.WATCHONLY_RECONCILE_INTERVAL_MS || DEFAULT_RECONCILE_INTERVAL_MS)) {
    const run = async () => {
        if (reconcileInFlight) return;
        reconcileInFlight = true;
        try {
            await bootstrapWatchOnlyRegistryFromSeed();
            await reconcileWatchOnlyRegistry();
        } catch (error) {
            console.warn('[watchonly-registry] reconcile failed:', error?.message || error);
        } finally {
            reconcileInFlight = false;
        }
    };

    void run();
    const timer = setInterval(() => {
        void run().catch((error) => {
            console.warn('[watchonly-registry] reconcile failed:', error?.message || error);
        });
    }, Math.max(60_000, Number.isFinite(intervalMs) ? intervalMs : DEFAULT_RECONCILE_INTERVAL_MS));
    timer.unref?.();
    return timer;
}
