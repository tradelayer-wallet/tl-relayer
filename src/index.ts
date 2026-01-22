import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { handleRpcConnection } from './config/rpc.config';
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
        if(!this.port){this.port=8000}
        this.server.listen(this.port, '0.0.0.0')
            .then(() => console.log(`Server Started On Port ${this.port}`))
            .catch((error) => this.stop(error.message));
    }

    private stop(message: string) {
        console.error(message);
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


const port = envConfig.SERVER_PORT;
const options: FastifyServerOptions = { logger: true };
const myServer = new FastifyServer(port, options);
myServer.start();