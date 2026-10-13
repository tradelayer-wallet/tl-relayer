import Fastify, { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { handleRoutes } from './routes/routes';
import { handleRpcConnection } from './config/rpc.config';
import { envConfig } from './config/env.config';
import { isInternalRelayRequest, secureCompare } from './services/security-utils.service';
import { WsRelayService } from './services/ws-relay.service';
import { startWatchOnlyRegistryReconciliation } from './services/watchonly-registry.service';

// Issue #1 / C1: optional API-key gate (x-api-key) for non-safe routes when
// RELAYER_API_KEY is set. The policy is inverted: every route that is not
// GET/HEAD/OPTIONS is protected by default, and only the small explicit
// allowlist below stays public. New mutating routes are therefore safe by
// default and must be added to the allowlist deliberately.
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Explicit public allowlist for non-safe (state-changing) methods. Keep this
// list small: everything NOT listed here requires a matching x-api-key header.
// Only read-only endpoints with no relayer/node state changes belong here.
const PUBLIC_UNSAFE_ROUTES = new Set([
    '/attestation/ip',     // POST alias of the public GET /attestation/ip (read-only reputation lookup)
    '/attestation/check',  // read-only IP reputation lookup
    '/tx/decode',          // pure local tx decoder, no state change
]);

// Safe-method (GET/HEAD) routes that still require the key: they change state
// or move funds despite being reads.
const isProtectedGetRoute = (path: string): boolean =>
    path === '/address/faucet' || path.indexOf('/address/faucet/') === 0;

const isProtectedRoute = (method: string, path: string): boolean => {
    const verb = String(method || '').toUpperCase();
    if (verb === 'OPTIONS') return false;
    if (SAFE_HTTP_METHODS.has(verb)) return isProtectedGetRoute(path);
    return !PUBLIC_UNSAFE_ROUTES.has(path);
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
        this.validateSecurityConfig();
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

    private validateSecurityConfig() {
        // Issue #1 / C1: the faucet moves real funds out of the node wallet.
        // FAUCET_ENABLED without ADMIN_API_KEY would leave it unauthenticated,
        // so refuse to start in that configuration (fail closed).
        if (envConfig.FAUCET_ENABLED && !envConfig.ADMIN_API_KEY) {
            this.stop(
                '[security] FAUCET_ENABLED=true requires ADMIN_API_KEY to be set; refusing to start because the faucet would be unauthenticated.',
            );
        }
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
                '[security] RELAYER_API_KEY is not set; all routes (including state-changing ones) are unauthenticated. Set RELAYER_API_KEY to require an x-api-key header on every non-safe route except the explicit public allowlist.',
            );
            return;
        }
        this.server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
            const path = String(request.url || '').split('?')[0];
            if (!isProtectedRoute(request.method, path)) return;
            // In-process WS relay: the client key was validated once at WS
            // handshake, and the relay presents the per-process internal marker
            // on its app.inject path (see security-utils.service.ts).
            if (isInternalRelayRequest(request.headers)) return;
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
