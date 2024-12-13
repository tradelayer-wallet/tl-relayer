import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import fs from 'fs';
import path from 'path';
import { handleRoutes } from './routes/routes';
import { handleRpcConenction } from './config/rpc.config';
import { envConfig } from './config/env.config';
import { initSocketConnection } from './services/socket.service';

class FastifyServer {
    private _server: FastifyInstance;

    constructor(
        private port: number, 
        private options: FastifyServerOptions,
    ) {
        this._server = Fastify(options);
    }

    private get server() {
        return this._server
    }

    start() {
        this.handleRoutes();
        this.handleRpcConnection();
        // this.handleSockets()
        this.server.listen(this.port, '0.0.0.0')
            .then(() => console.log(`Server Started On Port ${this.port} with SSL`))
            .catch((error) => this.stop(error.message));
    }

    private stop(message: string) {
        this.server.log.error(message);
        process.exit(1);
    }

    private handleSockets() {
        initSocketConnection(this.server)
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

const port = envConfig.SERVER_PORT;
const options: FastifyServerOptions = { 
    logger: true, 
    https: sslOptions 
};
const myServer = new FastifyServer(port, options);
myServer.start();
