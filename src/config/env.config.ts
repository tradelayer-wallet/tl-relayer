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
    SERVER_PORT: parseInt(process.env.SERVER_PORT || '8000', 10), // Default to 3000 if not set
    SOCKET_PORT: parseInt(process.env.SOCKET_PORT || '8001', 10), // Default to 3001 if not set
    NETWORK: process.env.NETWORK || 'TESTNET', // Default to 'TESTNET' if not set
    RPC_USER: process.env.RPC_USER || 'defaultUser', // Provide a default placeholder
    RPC_PASS: process.env.RPC_PASS || 'defaultPass', // Provide a default placeholder
    RPC_HOST: process.env.RPC_HOST || 'localhost', // Default to 'localhost' if not set
    RPC_PORT: parseInt(process.env.RPC_PORT || '8332', 10), // Default to a common RPC port (e.g., Bitcoin's default)
};
