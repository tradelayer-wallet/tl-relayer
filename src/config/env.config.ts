import * as dotenv from 'dotenv';
import { join } from 'path';

const envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
const path = join('environments', envFile);
dotenv.config({ path });

export const envConfig: {
    SERVER_PORT: number;
    NETWORK: string;
    RPC_USER: string;
    RPC_PASS: string;
    RPC_HOST: string;
    RPC_PORT: number;
} = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
    NETWORK: process.env.NETWORK,
    RPC_USER: process.env.RPC_USER,
    RPC_PASS: process.env.RPC_PASS,
    RPC_HOST: process.env.RPC_HOST,
    RPC_PORT: parseInt(process.env.RPC_PORT),
};