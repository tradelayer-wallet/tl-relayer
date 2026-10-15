import axios from 'axios';

import { envConfig } from '../config/env.config';
import { isOutboundSafeAddress, OUTBOUND_LIMITS } from './security-utils.service';
import { utxoSetDigest } from './utxo-digest.service';

const CHAIN_SO_PAGE_SIZE = 10;
const CHAIN_SO_MAX_PAGES = 20;

export interface ExternalWatchOnlyUtxo {
    txid: string;
    vout: number;
    amount: number;
    confirmations: number;
    scriptPubKey?: string;
}

export interface ExternalWatchOnlySnapshot {
    source: string;
    network: string;
    address: string;
    checkedAt: number;
    hash: string;
    count: number;
    totalAmount: number;
    utxos: ExternalWatchOnlyUtxo[];
}

function normalize(value: string): string {
    return String(value || '').trim();
}

function normalizeNetwork(network: string): string | null {
    const u = normalize(network).toUpperCase();
    if (!u) return null;
    if (u.includes('LTC') && u.includes('TEST')) return 'LTCTEST';
    if (u.includes('LTC')) return 'LTC';
    if (u.includes('BTC') && u.includes('TEST')) return 'BTCTEST';
    if (u.includes('BTC')) return 'BTC';
    if (u.includes('TEST')) return 'LTCTEST';
    return null;
}

function toUtxo(item: any): ExternalWatchOnlyUtxo | null {
    if (!item || typeof item !== 'object') return null;
    const txid = normalize(String(item.hash || item.txid || ''));
    const vout = Number(item.index ?? item.vout);
    if (!txid || !Number.isInteger(vout)) return null;
    const amount = Number(item.value ?? item.amount ?? 0);
    return {
        txid,
        vout,
        amount: Number.isFinite(amount) ? amount : 0,
        confirmations: Number.isFinite(Number(item.confirmations)) ? Number(item.confirmations) : (item.block != null ? 1 : 0),
        scriptPubKey: item.script == null ? undefined : String(item.script),
    };
}

export async function fetchExternalWatchOnlySnapshot(address: string, network?: string): Promise<ExternalWatchOnlySnapshot | null> {
    const mappedNetwork = normalizeNetwork(network || envConfig.NETWORK || '');
    const source = normalize(envConfig.WATCHONLY_EXTERNAL_UTXO_SOURCE || 'sochain').toLowerCase();
    if (!mappedNetwork || source !== 'sochain') {
        return null;
    }
    // Round 8: the address is placed in the URL path, and the API key header is sent with
    // every page. The address comes from a public route parameter, so a value with `/`,
    // `..`, `?` or `#` must never reach the request. Fail closed before any outbound call.
    const safeAddress = normalize(address);
    if (!isOutboundSafeAddress(safeAddress)) {
        return null;
    }

    const apiKey = normalize(envConfig.WATCHONLY_EXTERNAL_API_KEY || '');
    const headers = apiKey ? { 'API-KEY': apiKey } : undefined;
    const allUtxos: ExternalWatchOnlyUtxo[] = [];
    for (let page = 1; ; page += 1) {
        // A set that is still going after the page cap is refused rather than reported: a
        // truncated set would compare as a mismatch for every wallet with more outputs than the cap.
        if (page > CHAIN_SO_MAX_PAGES) return null;
        const url = `https://chain.so/api/v3/unspent_outputs/${mappedNetwork}/${encodeURIComponent(safeAddress)}/${page}`;
        const res = await axios.get(url, {
            timeout: 15000,
            headers,
            maxRedirects: 0,
            maxContentLength: OUTBOUND_LIMITS.utxoPageMaxResponseBytes,
        });
        const payload: any = res.data || {};
        const outputs = payload?.data?.outputs;
        // A page that is not a success answer, or that carries an unreadable output, makes the
        // whole set unknown. Reporting the pages read so far would present a partial set as complete.
        if (String(payload?.status || '').toLowerCase() !== 'success' || !Array.isArray(outputs)) return null;
        const mapped = outputs.map(toUtxo);
        if (mapped.some((utxo: ExternalWatchOnlyUtxo | null) => utxo === null)) return null;
        allUtxos.push(...(mapped as ExternalWatchOnlyUtxo[]));
        if (outputs.length < CHAIN_SO_PAGE_SIZE) break;
    }

    const digest = utxoSetDigest(allUtxos);
    return {
        source: 'sochain',
        network: mappedNetwork,
        address: safeAddress,
        checkedAt: Date.now(),
        hash: digest.digest,
        count: digest.count,
        totalAmount: digest.totalSats / 1e8,
        utxos: allUtxos,
    };
}
