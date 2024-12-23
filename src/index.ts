import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { handleRoutes } from './routes/routes';
import { handleRpcConenction } from './config/rpc.config';
import { envConfig } from './config/env.config';
import { initSocketConnection } from './services/socket.service';
import cors from '@fastify/cors';



class FastifyServer {
    private _server: FastifyInstance;

    constructor(private port: number, private options: FastifyServerOptions) {
        this._server = Fastify(options);

        // Register CORS
        this._server.register(cors, {
            origin: 'https://www.layerwallet.com', // Restrict to your domain
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
        });
    }
    
    private get server() {
        return this._server;
    }

    start() {
        this.handleRoutes();
        this.handleRpcConnection();
        // this.handleSockets();
        this.server.listen({ port: this.port, host: '0.0.0.0' })
            .then(() => console.log(`Server Started On Port ${this.port} with SSL`))
            .catch((error) => this.stop(error.message));
    }

    private stop(message: string) {
        this.server.log.error(message);
        process.exit(1);
    }

    private handleSockets() {
        initSocketConnection(this.server);
    }

    private handleRoutes() {
        handleRoutes(this.server);
    }

    private async handleRpcConnection() {
        const connected = await handleRpcConenction();
        const message = connected ? `RPC Connected` : `ERROR: RPC connection fails`;
        console.log(message);
    }
}

const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, '../ssl/privkey.pem')),
    cert: fs.readFileSync(path.join(__dirname, '../ssl/fullchain.pem')),
};

const httpsServer = https.createServer(sslOptions);

const port = envConfig.SERVER_PORT ||443;
const options: FastifyServerOptions = {
    logger: true,
    serverFactory: (handler) => httpsServer.on('request', handler),
};

const myServer = new FastifyServer(port, options);
myServer.start();
