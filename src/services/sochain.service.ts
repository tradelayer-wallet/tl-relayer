import * as os from 'node:os';
import { envConfig } from "../config/env.config";
import { callRpc, getWatchOnlyRegistryPubkey, importPubKey } from "./address.service";
import {
    getWatchOnlyCoverage,
    listWatchOnlyEntries,
    recordWatchOnlySnapshot,
    upsertWatchOnlyEntry,
} from "./watchonly-registry.service";

const baseURL = "https://api.blockcypher.com/v1/";
const token = "a2b9d2c5fbfc49f39589c2751f599725"; // BlockCypher API token

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

        console.log('params in listunspent ' + address + ' ' + effectivePubkey);

        const label = "";

        // Validate the address
        const addressInfo = await callRpc('getaddressinfo', address);
        console.log(JSON.stringify(addressInfo));

        if (!addressInfo || !addressInfo.data || !addressInfo.data.ismine) {
            console.log('Address not recognized as owned. ' + JSON.stringify(addressInfo));

            // Check if the pubkey needs to be imported
            if (effectivePubkey) {
                upsertWatchOnlyEntry({
                    network,
                    address,
                    pubkey: effectivePubkey,
                    imported: false,
                });

                const importResult = await importPubKey(server, [effectivePubkey, address]);
                console.log('Import result ' + JSON.stringify(importResult));

                if (importResult.error) {
                    throw new Error(`Failed to import pubkey: ${importResult.error}`);
                }
            } else {
                throw new Error(`Address is not valid and no pubkey provided for import.`);
            }
        }

        // Attempt to fetch unspent UTXOs using the RPC client
        const luRes = await callRpc('listunspent', minBlock, maxBlock, [address]);
        console.log('outputs for ' + address + ' ' + JSON.stringify(luRes));

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

        recordWatchOnlySnapshot({
            network,
            address,
            pubkey: effectivePubkey,
            utxos: data,
            scannedHeight: Number.isFinite(currentHeight) ? currentHeight : null,
            scanState: scanOptions.scanState || 'live',
            scanSourceNodeId: scanOptions.scanSourceNodeId || `${os.hostname()}:${process.pid}`,
        });

        return { data };
    } catch (error: unknown) {
        console.error('Error in listunspent: ', error);
        return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
};

export const rescanWatchOnlyAccounts = async (
    server: any,
    params?: {
        network?: string;
        address?: string;
        fromHeight?: number | null;
        toHeight?: number | null;
        scanSourceNodeId?: string | null;
        force?: boolean;
    }
): Promise<{ data?: any; error?: string }> => {
    try {
        const network = String(params?.network || envConfig.NETWORK || '').trim();
        const address = String(params?.address || '').trim();
        const scanSourceNodeId = String(params?.scanSourceNodeId || `${os.hostname()}:${process.pid}`).trim();
        const force = !!params?.force;

        const entries = await listWatchOnlyEntries({
            network: network || undefined,
            address: address || undefined,
        });

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
            return {
                address: entry.address,
                coverage: currentCoverage,
            };
        }));

        const staleCoverage = coverage
            .map((item) => item.coverage)
            .filter((item): item is NonNullable<typeof item> => !!item && (item.needsRescan || force));

        const startHeightCandidates = staleCoverage
            .reduce<number[]>((acc, item) => {
                if (Number.isFinite(Number(item.lastSnapshotHeight)) && Number(item.lastSnapshotHeight) >= 0) {
                    acc.push(Number(item.lastSnapshotHeight));
                }
                if (Number.isFinite(Number(item.lastScannedHeight)) && Number(item.lastScannedHeight) >= 0) {
                    acc.push(Number(item.lastScannedHeight));
                }
                return acc;
            }, [])
            .filter((value): value is number => Number.isFinite(Number(value)) && Number(value) >= 0)
            .map((value) => Number(value));
        const fromHeight = Number.isFinite(Number(params?.fromHeight))
            ? Math.max(0, Number(params?.fromHeight))
            : startHeightCandidates.length
                ? Math.max(0, Math.min(...startHeightCandidates))
                : 0;
        const toHeight = Number.isFinite(Number(params?.toHeight))
            ? Math.max(0, Number(params?.toHeight))
            : null;

        let rescanResult: any = null;
        if (force || staleCoverage.length) {
            const rescanParams = toHeight == null ? [fromHeight] : [fromHeight, toHeight];
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
                    scanState: force || entryCoverage?.needsRescan ? 'backfilled' : 'live',
                    scanSourceNodeId,
                },
            ]);

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
