import axios from 'axios';

import { envConfig } from '../config/env.config';

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

function computeHash(utxos: ExternalWatchOnlyUtxo[]): string {
    const canonical = (utxos || []).slice().sort((a, b) => {
        if (a.txid === b.txid) {
            return a.vout - b.vout;
        }
        return a.txid.localeCompare(b.txid);
    });
    return require('crypto').createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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

    const apiKey = normalize(envConfig.WATCHONLY_EXTERNAL_API_KEY || '');
    const headers = apiKey ? { 'API-KEY': apiKey } : undefined;
    const allUtxos: ExternalWatchOnlyUtxo[] = [];
    let page = 1;
    while (page <= 20) {
        const url = `https://chain.so/api/v3/unspent_outputs/${mappedNetwork}/${address}/${page}`;
        const res = await axios.get(url, {
            timeout: 15000,
            headers,
        });
        const payload: any = res.data || {};
        if (String(payload?.status || '').toLowerCase() !== 'success') {
            break;
        }
        const outputs = Array.isArray(payload?.data?.outputs) ? payload.data.outputs : [];
        const mapped = outputs.map(toUtxo).filter(Boolean) as ExternalWatchOnlyUtxo[];
        allUtxos.push(...mapped);
        if (outputs.length < 10) {
            break;
        }
        page += 1;
    }

    const checkedAt = Date.now();
    return {
        source: 'sochain',
        network: mappedNetwork,
        address: normalize(address),
        checkedAt,
        hash: computeHash(allUtxos),
        count: allUtxos.length,
        totalAmount: allUtxos.reduce((sum, item) => sum + Number(item.amount || 0), 0),
        utxos: allUtxos,
    };
}
