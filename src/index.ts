import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';

import { envConfig } from './config/env.config';

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
        this.server.listen(this.port)
            .then(() => console.log(`Server Started On Port ${this.port}`))
            .catch((error) => this.stop(error.message));
    }

    private stop(message: string) {
        this.server.log.error(message);
        process.exit(1);
    }

    private handleRoutes() {
        handleRoutes(this.server);
    }
}


const port = envConfig.SERVER_PORT;
const options: FastifyServerOptions = {};
const myServer = new FastifyServer(port, options);
myServer.start();