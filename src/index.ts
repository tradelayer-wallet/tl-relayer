import Fastify, { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { handleRpcConnection } from './config/rpc.config';
import { envConfig } from './config/env.config';
import { secureCompare } from './services/security-utils.service';
import { WsRelayService } from './services/ws-relay.service';
import { startWatchOnlyRegistryReconciliation } from './services/watchonly-registry.service';

// Issue #1 / C1: optional API-key gate for state-changing routes. When
// RELAYER_API_KEY is set, these routes require a matching `x-api-key` header.
const isProtectedRoute = (method: string, path: string): boolean => {
    const verb = String(method || '').toUpperCase();
    if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return false;
    if (path === '/tx/sendTx') return true;
    if (path === '/address/sync-watchonly') return true;
    if (path === '/address/watchonly' || path.indexOf('/address/watchonly/') === 0) return true;
    if (path === '/rpc' || path.indexOf('/rpc/') === 0) return true;
    return false;
};

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

    async start() {
        await this.handleCors();
        this.handleAuth();
        this.handleRoutes();
        await this.handleRpcConnection();
        this.handleSockets();
        this.handleWatchOnlyRegistry();
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
        new WsRelayService(this.server);
    }

    private handleWatchOnlyRegistry() {
        startWatchOnlyRegistryReconciliation();
    }

    private handleRoutes() {
        handleRoutes(this.server);
    }

    private handleAuth() {
        const apiKey = envConfig.RELAYER_API_KEY;
        if (!apiKey) {
            console.warn(
                '[security] RELAYER_API_KEY is not set; state-changing routes (POST /tx/sendTx, /address/sync-watchonly, /address/watchonly/*, /rpc/*) are unauthenticated. Set RELAYER_API_KEY to require an x-api-key header.',
            );
            return;
        }
        this.server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
            const path = String(request.url || '').split('?')[0];
            if (!isProtectedRoute(request.method, path)) return;
            const provided = String(request.headers['x-api-key'] || '');
            if (!provided || !secureCompare(provided, apiKey)) {
                reply.code(401).send({ error: 'Missing or invalid x-api-key header' });
                return reply;
            }
        });
    }

    private async handleRpcConnection() {
        const connected = await handleRpcConnection();
        const message = connected ? `RPC Connected` : `ERROR: RPC connection fails`;
        console.log(message);
    }

    private async handleCors() {
        // Issue #1 / M1: explicit origin allowlist via CORS_ORIGINS (comma-separated).
        // Without it, keep the previous permissive behavior but never combine
        // `origin: true` (reflect any origin) with `credentials: true`.
        const allowedOrigins = envConfig.CORS_ORIGINS;
        const isPermissive = allowedOrigins.length === 0;
        if (isPermissive) {
            console.warn(
                '[security] CORS_ORIGINS is not set; reflecting any origin without credentials. Set CORS_ORIGINS to an explicit allowlist for production.',
            );
        }
        await this.server.register(require('@fastify/cors'), {
            origin: isPermissive ? true : allowedOrigins,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            credentials: !isPermissive,
        });
    }
}


const port = envConfig.SERVER_PORT;
const options: FastifyServerOptions = { logger: true };
const myServer = new FastifyServer(port, options);
myServer.start();
