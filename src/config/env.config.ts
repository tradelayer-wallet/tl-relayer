import * as dotenv from 'dotenv';
import { join } from 'path';

const envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
const path = join('environments', envFile);
dotenv.config({ path });

export const envConfig: {
    SERVER_PORT: number;
    SOCKET_PORT: number;
    NETWORK: string;
    RPC_USER: string;
    RPC_PASS: string;
    RPC_HOST: string;
    RPC_PORT: number;
    COLLATOR_URL: string;
    COLLATOR_RPC_SERVICE: string;
    COLLATOR_RPC_NETWORK: string;
    WATCH_RPC_USER: string;
    WATCH_RPC_PASS: string;
    WATCH_RPC_HOST: string;
    WATCH_RPC_PORT: number;
    RELAYER_STATE_DIR: string;
    WATCHONLY_REGISTRY_PATH: string;
    VPN_KEYS: {
        VPN_CRIMINALIP: string;
        VPN_IPHUB: string;
        VPN_IPINFO: string;
        VPN_IPHUNTER: string;
        VPN_VPNAPI: string;
    };
} = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
    SOCKET_PORT: parseInt(process.env.SOCKET_PORT),
    NETWORK: process.env.NETWORK,
    RPC_USER: process.env.RPC_USER,
    RPC_PASS: process.env.RPC_PASS,
    RPC_HOST: process.env.RPC_HOST,
    RPC_PORT: parseInt(process.env.RPC_PORT),
    COLLATOR_URL: process.env.TL_COLLATOR_URL || process.env.COLLATOR_URL || '',
    COLLATOR_RPC_SERVICE: process.env.TL_COLLATOR_RPC_SERVICE || process.env.COLLATOR_RPC_SERVICE || 'tradelayer.rpc',
    COLLATOR_RPC_NETWORK: process.env.TL_COLLATOR_RPC_NETWORK || process.env.COLLATOR_RPC_NETWORK || process.env.NETWORK || '',
    WATCH_RPC_USER: process.env.WATCH_RPC_USER || process.env.RPC_USER,
    WATCH_RPC_PASS: process.env.WATCH_RPC_PASS || process.env.RPC_PASS,
    WATCH_RPC_HOST: process.env.WATCH_RPC_HOST || process.env.RPC_HOST,
    WATCH_RPC_PORT: parseInt(process.env.WATCH_RPC_PORT || process.env.RPC_PORT),
    RELAYER_STATE_DIR: process.env.TL_RELAYER_STATE_DIR || process.env.RELAYER_STATE_DIR || '',
    WATCHONLY_REGISTRY_PATH: process.env.TL_WATCHONLY_REGISTRY_PATH || process.env.WATCHONLY_REGISTRY_PATH || '',
    VPN_KEYS: {
        VPN_CRIMINALIP: process.env.VPN_CRIMINALIP,
        VPN_IPHUB: process.env.VPN_IPHUB,
        VPN_IPINFO: process.env.VPN_IPINFO,
        VPN_IPHUNTER: process.env.VPN_IPHUNTER,
        VPN_VPNAPI: process.env.VPN_VPNAPI,
    },
};
