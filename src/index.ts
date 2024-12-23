import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { handleRoutes } from './routes/routes';
import { handleRpcConenction } from './config/rpc.config';
import { envConfig } from './config/env.config';
import { initSocketConnection } from './services/socket.service';

class FastifyServer {
    private _server;

    constructor(private port: number) {
        this._server = Fastify({
            logger: true,
            
        });
    }

    private get server() {
        return this._server;
    }

    async start() {
        this.registerCors();
        this.handleRoutes();
        await this.handleRpcConnection();
        await this.server.listen({ port: this.port, host: '0.0.0.0' });
        console.log(`Server started on port ${this.port}`);
    }

    private stop(message: string) {
        console.error(message);
        process.exit(1);
    }

    private registerCors() {
        this.server.register(cors, {
            origin: 'https://www.layerwallet.com',
            methods: ['GET', 'POST', 'OPTIONS'],
            credentials: true,
            allowedHeaders: ['Content-Type', 'Authorization'],
        });
    }

    private handleRoutes() {
        handleRoutes(this.server);
    }

    private async handleRpcConnection() {
        const connected = await handleRpcConenction();
        if (!connected) {
            this.stop('RPC connection failed.');
        }
        console.log('RPC Connected');
    }
}

const port = envConfig.SERVER_PORT || 8000;
const myServer = new FastifyServer(port);
myServer.start();
