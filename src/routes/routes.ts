import { FastifyInstance } from "fastify";
import { addressRoute } from "./address.route";
import { chainRoute } from "./chain.route";
import { rpcRoutes } from "./rpc.route";
import { tokenRoute } from "./token.route";
import { txRoute } from "./tx.route";
import { registerAttestationRoutes } from "./attestation.route";

export const handleRoutes = (server: FastifyInstance) => {

    server.register(require('fastify-axios'));

    server.register(addressRoute, { prefix: '/address' });
    server.register(txRoute,      { prefix: '/tx' });
    server.register(tokenRoute,   { prefix: '/token' });
    server.register(chainRoute,   { prefix: '/chain' });
    server.register(rpcRoutes,    { prefix: '/rpc' });
    server.register(registerAttestationRoutes, { prefix: '/attestation' });
};
