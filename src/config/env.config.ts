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
} = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
    SOCKET_PORT: parseInt(process.env.SOCKET_PORT),
    NETWORK: process.env.NETWORK,
    RPC_USER: process.env.RPC_USER,
    RPC_PASS: process.env.RPC_PASS,
    RPC_HOST: process.env.RPC_HOST,
    RPC_PORT: parseInt(process.env.RPC_PORT),
    VPN_KEYS: {
        VPN_CRIMINALIP: process.env.VPN_CRIMINALIP,
        VPN_IPHUB: process.env.VPN_IPHUB,
        VPN_IPINFO: process.env.VPN_IPINFO,
        VPN_IPHUNTER: process.env.VPN_IPHUNTER,
        VPN_VPNAPI: process.env.VPN_VPNAPI,
    },
};
