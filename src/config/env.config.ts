import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

const envCandidates =
    process.env.NODE_ENV === 'production'
        ? ['production.env', 'development.env', 'example.env.expl']
        : ['development.env', 'example.env.expl', 'production.env'];

const envPath = envCandidates
    .map((file) => join('environments', file))
    .find((candidate) => existsSync(candidate));

if (envPath) {
    dotenv.config({ path: envPath });
}

const parsePort = (value: string | undefined, fallback: number) => {
    const parsed = parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBool = (value: string | undefined) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
};

const parseCsv = (value: string | undefined) =>
    String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

export const envConfig: {
    SERVER_PORT: number;
    SOCKET_PORT: number;
    NETWORK: string;
    RPC_USER: string;
    RPC_PASS: string;
    RPC_HOST: string;
    RPC_PORT: number;
    TL_LISTENER_URL: string;
    COLLATOR_URL: string;
    COLLATOR_RPC_SERVICE: string;
    COLLATOR_RPC_NETWORK: string;
    WATCHONLY_REGISTRY_SEED_URL: string;
    WATCHONLY_EXTERNAL_UTXO_SOURCE: string;
    WATCHONLY_EXTERNAL_API_KEY: string;
    WATCHONLY_RESCAN_OPT_IN: boolean;
    WATCHONLY_RESCAN_LOOKBACK_BLOCKS: number;
    WATCH_RPC_USER: string;
    WATCH_RPC_PASS: string;
    WATCH_RPC_HOST: string;
    WATCH_RPC_PORT: number;
    WATCHONLY_REGISTRY_PATH: string;
    WATCHONLY_RECONCILE_INTERVAL_MS: number;
    WATCHONLY_BOOTSTRAP_URL: string;
    ALLOW_INSECURE_BOOTSTRAP: boolean;
    RELAYER_API_KEY: string;
    ADMIN_API_KEY: string;
    FAUCET_ENABLED: boolean;
    CORS_ORIGINS: string[];
    TRUST_PROXY: boolean;
    BLOCKCYPHER_TOKEN: string;
    VPN_KEYS: {
        VPN_CRIMINALIP: string;
        VPN_IPHUB: string;
        VPN_IPINFO: string;
        VPN_IPHUNTER: string;
        VPN_VPNAPI: string;
    };
} = {
    SERVER_PORT: parsePort(process.env.SERVER_PORT, 9191),
    SOCKET_PORT: parsePort(process.env.SOCKET_PORT, 9192),
    NETWORK: process.env.NETWORK || 'LTC',
    RPC_USER: process.env.RPC_USER || '',
    RPC_PASS: process.env.RPC_PASS || '',
    RPC_HOST: process.env.RPC_HOST || '127.0.0.1',
    RPC_PORT: parsePort(process.env.RPC_PORT, 9332),
    TL_LISTENER_URL: process.env.TL_LISTENER_URL || process.env.TRADELAYER_LISTENER_URL || 'http://127.0.0.1:3000',
    COLLATOR_URL: process.env.TL_COLLATOR_URL || process.env.COLLATOR_URL || '',
    COLLATOR_RPC_SERVICE: process.env.TL_COLLATOR_RPC_SERVICE || process.env.COLLATOR_RPC_SERVICE || 'tradelayer.rpc',
    COLLATOR_RPC_NETWORK: process.env.TL_COLLATOR_RPC_NETWORK || process.env.COLLATOR_RPC_NETWORK || process.env.NETWORK || '',
    WATCHONLY_REGISTRY_SEED_URL: process.env.WATCHONLY_REGISTRY_SEED_URL || process.env.TL_WATCHONLY_REGISTRY_SEED_URL || '',
    WATCHONLY_EXTERNAL_UTXO_SOURCE: process.env.WATCHONLY_EXTERNAL_UTXO_SOURCE || 'sochain',
    WATCHONLY_EXTERNAL_API_KEY: process.env.WATCHONLY_EXTERNAL_API_KEY || '',
    WATCHONLY_RESCAN_OPT_IN: String(process.env.WATCHONLY_RESCAN_OPT_IN || '').trim().toLowerCase() === '1' || String(process.env.WATCHONLY_RESCAN_OPT_IN || '').trim().toLowerCase() === 'true',
    WATCHONLY_RESCAN_LOOKBACK_BLOCKS: parseInt(process.env.WATCHONLY_RESCAN_LOOKBACK_BLOCKS || '10', 10),
    WATCH_RPC_USER: process.env.WATCH_RPC_USER || process.env.RPC_USER,
    WATCH_RPC_PASS: process.env.WATCH_RPC_PASS || process.env.RPC_PASS,
    WATCH_RPC_HOST: process.env.WATCH_RPC_HOST || process.env.RPC_HOST,
    WATCH_RPC_PORT: parsePort(process.env.WATCH_RPC_PORT || process.env.RPC_PORT, 9332),
    WATCHONLY_REGISTRY_PATH: process.env.WATCHONLY_REGISTRY_PATH || 'state/watchonly-registry.json',
    WATCHONLY_RECONCILE_INTERVAL_MS: parseInt(process.env.WATCHONLY_RECONCILE_INTERVAL_MS || '300000', 10),
    WATCHONLY_BOOTSTRAP_URL: String(process.env.WATCHONLY_BOOTSTRAP_URL || process.env.TL_WATCHONLY_BOOTSTRAP_URL || '').trim(),
    ALLOW_INSECURE_BOOTSTRAP: parseBool(process.env.ALLOW_INSECURE_BOOTSTRAP),
    RELAYER_API_KEY: String(process.env.RELAYER_API_KEY || '').trim(),
    ADMIN_API_KEY: String(process.env.ADMIN_API_KEY || '').trim(),
    FAUCET_ENABLED: parseBool(process.env.FAUCET_ENABLED),
    CORS_ORIGINS: parseCsv(process.env.CORS_ORIGINS),
    TRUST_PROXY: parseBool(process.env.TRUST_PROXY),
    BLOCKCYPHER_TOKEN: String(process.env.BLOCKCYPHER_TOKEN || '').trim(),
    VPN_KEYS: {
        VPN_CRIMINALIP: process.env.VPN_CRIMINALIP,
        VPN_IPHUB: process.env.VPN_IPHUB,
        VPN_IPINFO: process.env.VPN_IPINFO,
        VPN_IPHUNTER: process.env.VPN_IPHUNTER,
        VPN_VPNAPI: process.env.VPN_VPNAPI,
    },
};
