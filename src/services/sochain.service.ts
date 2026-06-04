import * as os from 'node:os';
import { envConfig } from "../config/env.config";
import { callRpc, getWatchOnlyRegistryPubkey, importPubKey } from "./address.service";
import { fetchExternalWatchOnlySnapshot } from "./watchonly-external.service";
import {
    getWatchOnlyCoverage,
    listWatchOnlyEntries,
    recordWatchOnlySnapshot,
    resolveWatchOnlyRescanStartHeight,
    upsertWatchOnlyEntry,
} from "./watchonly-registry.service";

const baseURL = "https://api.blockcypher.com/v1/";
const token = "a2b9d2c5fbfc49f39589c2751f599725"; // BlockCypher API token

function logPortfolioHeartbeat(scope: string, event: string, details: Record<string, unknown>) {
    console.log(`[portfolio-heartbeat][relayer][${scope}] ${event}`, details);
}

function deriveFirstFundingScanInfo(
    utxos: Array<{ txid: string; confirmations: number }>,
    currentHeight: number | null,
): { firstFundingHeight: number | null; firstFundingTxid: string | null } {
    const confirmed = (Array.isArray(utxos) ? utxos : [])
        .filter((u) => Number.isFinite(Number(u?.confirmations)) && Number(u.confirmations) > 0)
        .map((u) => ({
            txid: String(u?.txid || '').trim(),
            confirmations: Number(u.confirmations),
        }))
        .filter((u) => !!u.txid);

    if (!confirmed.length || !Number.isFinite(Number(currentHeight)) || Number(currentHeight) < 0) {
        return { firstFundingHeight: null, firstFundingTxid: null };
    }

    const withHeights = confirmed.map((u) => ({
        txid: u.txid,
        height: Math.max(0, Number(currentHeight) - u.confirmations + 1),
    }));
    withHeights.sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
    const earliest = withHeights[0];
    return {
        firstFundingHeight: earliest?.height ?? null,
        firstFundingTxid: earliest?.txid ?? null,
    };
}

async function getCurrentChainHeight(): Promise<number | null> {
    const chainInfo = await callRpc('getblockchaininfo');
    const height = chainInfo?.data?.blocks ?? chainInfo?.data?.result?.blocks;
    const parsed = Number(height);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export const listunspent = async (
    server: any,
    params: [
        number,
        number,
        { address: string; pubkey?: string },
        {
            scanState?: 'new' | 'imported' | 'backfilled' | 'live' | 'stale';
            scanSourceNodeId?: string | null;
        }?
    ]
): Promise<{ data?: any; error?: string }> => {
    try {
        const { address, pubkey } = params[2];
        const scanOptions = params[3] || {};
        const minBlock = 0;
        const maxBlock = params[1] ?? 99999999;
        const network = envConfig.NETWORK || '';
        const registryPubkey = await getWatchOnlyRegistryPubkey(address);
        const effectivePubkey = pubkey || registryPubkey || '';

        if (!address) {
            return { error: `Error with getting UTXOs. Code: 0` };
        }

        logPortfolioHeartbeat('utxo', 'request', {
            address,
            network,
            hasPubkey: !!effectivePubkey,
            scanState: scanOptions.scanState || 'live',
            scanSourceNodeId: scanOptions.scanSourceNodeId || null,
            minBlock,
            maxBlock,
        });

        const label = "";

        // Validate the address
        const addressInfo = await callRpc('getaddressinfo', address);
        logPortfolioHeartbeat('utxo', 'address-info', {
            address,
            ismine: !!addressInfo?.data?.ismine,
            iswatchonly: !!addressInfo?.data?.iswatchonly,
        });

        if (!addressInfo || !addressInfo.data || !addressInfo.data.ismine) {
            logPortfolioHeartbeat('utxo', 'address-unowned', {
                address,
                hasPubkey: !!effectivePubkey,
            });

            // Check if the pubkey needs to be imported
            if (effectivePubkey) {
                upsertWatchOnlyEntry({
                    network,
                    address,
                    pubkey: effectivePubkey,
                    imported: false,
                });

                const importResult = await importPubKey(server, [effectivePubkey, address]);
                logPortfolioHeartbeat('utxo', 'importpubkey', {
                    address,
                    imported: !importResult.error,
                    error: importResult.error || null,
                });

                if (importResult.error) {
                    throw new Error(`Failed to import pubkey: ${importResult.error}`);
                }
            } else {
                throw new Error(`Address is not valid and no pubkey provided for import.`);
            }
        }

        // Attempt to fetch unspent UTXOs using the RPC client
        const luRes = await callRpc('listunspent', minBlock, maxBlock, [address]);
        logPortfolioHeartbeat('utxo', 'listunspent-result', {
            address,
            hasError: !!luRes.error,
            count: Array.isArray(luRes.data) ? luRes.data.length : 0,
        });

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

        const chainInfo = await callRpc('getblockchaininfo');
        const currentHeight = Number(chainInfo?.data?.blocks ?? chainInfo?.data?.result?.blocks);
        const firstFunding = deriveFirstFundingScanInfo(data, Number.isFinite(currentHeight) ? currentHeight : null);

        recordWatchOnlySnapshot({
            network,
            address,
            pubkey: effectivePubkey,
            utxos: data,
            scannedHeight: Number.isFinite(currentHeight) ? currentHeight : null,
            firstFundingHeight: firstFunding.firstFundingHeight,
            firstFundingTxid: firstFunding.firstFundingTxid,
            scanState: scanOptions.scanState || 'live',
            scanSourceNodeId: scanOptions.scanSourceNodeId || `${os.hostname()}:${process.pid}`,
        });

        logPortfolioHeartbeat('utxo', 'snapshot-recorded', {
            address,
            count: data.length,
            scannedHeight: Number.isFinite(currentHeight) ? currentHeight : null,
            scanSourceNodeId: scanOptions.scanSourceNodeId || `${os.hostname()}:${process.pid}`,
        });

        return { data };
    } catch (error: unknown) {
        console.error('[portfolio-heartbeat][relayer][utxo] error', {
            address: String(params?.[2]?.address || '').trim() || null,
            error: error instanceof Error ? error.message : String(error),
        });
        return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
};

async function resolveLocalAddressPubkey(address: string): Promise<string | undefined> {
    const addressInfo = await callRpc('getaddressinfo', address);
    const rawInfo: any = addressInfo as any;
    const info = rawInfo?.data || rawInfo?.result || {};
    const candidates = [
        info?.pubkey,
        info?.pubKey,
        info?.pubkeyHex,
        info?.pubkeyhex,
        info?.publicKey,
        info?.publickey,
    ];

    for (const candidate of candidates) {
        const pubkey = String(candidate || '').trim();
        if (pubkey) return pubkey;
    }

    return undefined;
}

export const verifyWatchOnlyAccountCoverage = async (
    address: string,
    network?: string,
): Promise<{
    ok: boolean;
    address: string;
    network: string;
    local: {
        hash: string | null;
        count: number;
        totalAmount: number;
        updatedAt: number | null;
    } | null;
    external: {
        source: string;
        hash: string;
        count: number;
        totalAmount: number;
        checkedAt: number;
        network: string;
    } | null;
    needsRescan: boolean;
    reason: string;
}> => {
    const entries = await listWatchOnlyEntries({ network, address });
    const localEntry = entries[0] || null;
    const externalSnapshot = await fetchExternalWatchOnlySnapshot(address, network);
    const localSnapshot = localEntry?.lastUtxoSnapshot || null;
    const localHash = localSnapshot?.hash ? String(localSnapshot.hash) : null;
    const externalHash = externalSnapshot?.hash ? String(externalSnapshot.hash) : null;
    const external = externalSnapshot
        ? {
            source: externalSnapshot.source,
            hash: externalSnapshot.hash,
            count: externalSnapshot.count,
            totalAmount: externalSnapshot.totalAmount,
            checkedAt: externalSnapshot.checkedAt,
            network: externalSnapshot.network,
        }
        : null;
    const local = localSnapshot
        ? {
            hash: localHash,
            count: Number(localSnapshot.count || 0),
            totalAmount: Number(localSnapshot.totalAmount || 0),
            updatedAt: Number(localSnapshot.updatedAt || 0) || null,
        }
        : null;

    const mismatch = !!externalSnapshot && (
        !localSnapshot ||
        localHash !== externalHash ||
        Number(localSnapshot.count || 0) !== externalSnapshot.count ||
        Number(localSnapshot.totalAmount || 0) !== externalSnapshot.totalAmount
    );

    return {
        ok: true,
        address,
        network: String(network || envConfig.NETWORK || ''),
        local,
        external,
        needsRescan: mismatch,
        reason: !externalSnapshot
            ? 'external utxo source unavailable'
            : !localSnapshot
                ? 'local snapshot missing'
                : mismatch
                    ? 'local snapshot differs from external utxo set'
                    : 'local snapshot matches external utxo set',
    };
};

export const rescanWatchOnlyAccounts = async (
    server: any,
    params?: {
        network?: string;
        address?: string;
        pubkey?: string;
        fromHeight?: number | null;
        toHeight?: number | null;
        lookbackBlocks?: number | null;
        scanSourceNodeId?: string | null;
        force?: boolean;
    }
): Promise<{ data?: any; error?: string }> => {
    try {
        const network = String(params?.network || envConfig.NETWORK || '').trim();
        const address = String(params?.address || '').trim();
        const requestedPubkey = String(params?.pubkey || '').trim();
        const scanSourceNodeId = String(params?.scanSourceNodeId || `${os.hostname()}:${process.pid}`).trim();
        const force = !!params?.force;
        const lookbackBlocks = Math.max(
            0,
            Number.isFinite(Number(params?.lookbackBlocks))
                ? Math.floor(Number(params?.lookbackBlocks))
                : Math.floor(Number(envConfig.WATCHONLY_RESCAN_LOOKBACK_BLOCKS || 10)),
        );

        let entries = await listWatchOnlyEntries({
            network: network || undefined,
            address: address || undefined,
        });

        if (address && !entries.some((entry) => entry.address === address)) {
            const resolvedPubkey = requestedPubkey || await resolveLocalAddressPubkey(address);
            if (resolvedPubkey) {
                const importResult = await importPubKey(server, [resolvedPubkey, address]);
                if (importResult.error) {
                    return { error: importResult.error };
                }

                entries = await listWatchOnlyEntries({
                    network: network || undefined,
                    address: address || undefined,
                });
            } else {
                return {
                    error: `Unable to import ${address}: no pubkey was provided and the local node did not return one.`,
                };
            }
        }

        if (!entries.length) {
            return {
                data: {
                    ok: true,
                    scanned: 0,
                    refreshed: 0,
                    skipped: 0,
                    failed: 0,
                    fromHeight: null,
                    toHeight: null,
                    rescan: null,
                    coverage: [],
                    results: [],
                },
            };
        }

        const coverage = await Promise.all(entries.map(async (entry) => {
            const currentCoverage = await getWatchOnlyCoverage(entry.address);
            const externalCoverage = await verifyWatchOnlyAccountCoverage(entry.address, network || undefined);
            return {
                address: entry.address,
                coverage: currentCoverage,
                externalCoverage,
            };
        }));

        const staleCoverage = coverage
            .map((item) => item.coverage)
            .filter((item): item is NonNullable<typeof item> => !!item && (item.needsRescan || force));
        const externalMismatch = coverage
            .map((item) => item.externalCoverage)
            .filter((item): item is NonNullable<typeof item> => !!item && item.needsRescan);

        const startHeightCandidates = staleCoverage
            .map((item) => resolveWatchOnlyRescanStartHeight({
                firstFundingHeight: item.firstFundingHeight ?? null,
                lastSnapshotHeight: item.lastSnapshotHeight ?? null,
                lastScannedHeight: item.lastScannedHeight ?? null,
            }))
            .filter((value): value is number => Number.isFinite(Number(value)) && Number(value) >= 0)
            .map((value) => Math.max(0, Number(value) - lookbackBlocks));
        const fromHeight = Number.isFinite(Number(params?.fromHeight))
            ? Math.max(0, Number(params?.fromHeight))
            : startHeightCandidates.length
                ? Math.max(0, Math.min(...startHeightCandidates))
                : Math.max(0, (await getCurrentChainHeight() ?? 0) - lookbackBlocks);
        const toHeight = Number.isFinite(Number(params?.toHeight))
            ? Math.max(0, Number(params?.toHeight))
            : null;

        let rescanResult: any = null;
        const allowRescan = !!envConfig.WATCHONLY_RESCAN_OPT_IN;
        const shouldRescan = force || (allowRescan && (staleCoverage.length > 0 || externalMismatch.length > 0));
        if (shouldRescan) {
            const rescanParams = toHeight == null ? [fromHeight] : [fromHeight, toHeight];
            logPortfolioHeartbeat('utxo', 'rescan-request', {
                network,
                address: address || null,
                fromHeight,
                toHeight,
                scanSourceNodeId,
                force,
                coverageCount: entries.length,
            });
            const rpcRes = await callRpc('rescanblockchain', ...rescanParams);
            if (rpcRes.error) {
                throw new Error(rpcRes.error);
            }
            rescanResult = rpcRes.data;
        }

        const results: Array<{ address: string; refreshed: boolean; error?: string }> = [];
        let refreshed = 0;
        let skipped = 0;
        let failed = 0;

        for (const entry of entries) {
            const entryCoverage = coverage.find((item) => item.address === entry.address)?.coverage;
            const listRes = await listunspent(server, [
                0,
                99999999,
                { address: entry.address, pubkey: entry.pubkey },
                {
                    scanState: shouldRescan && (force || entryCoverage?.needsRescan || externalMismatch.some((item) => item.address === entry.address))
                        ? 'backfilled'
                        : 'live',
                    scanSourceNodeId,
                },
            ]);
            logPortfolioHeartbeat('utxo', 'rescan-coverage', {
                address: entry.address,
                hasError: !!listRes.error,
                count: Array.isArray(listRes.data) ? listRes.data.length : 0,
                scanSourceNodeId,
            });

            if (listRes.error) {
                failed += 1;
                results.push({ address: entry.address, refreshed: false, error: listRes.error });
            } else {
                refreshed += 1;
                results.push({ address: entry.address, refreshed: true });
            }
        }

        const finalCoverage = await Promise.all(entries.map(async (entry) => ({
            address: entry.address,
            coverage: await getWatchOnlyCoverage(entry.address),
        })));

        return {
            data: {
                ok: true,
                scanned: entries.length,
                refreshed,
                skipped,
                failed,
                lookbackBlocks,
                allowRescan,
                externalMismatch,
                scanSourceNodeId,
                fromHeight,
                toHeight,
                rescan: rescanResult,
                coverage: finalCoverage,
                results,
            },
        };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { error: errorMessage };
    }
};
