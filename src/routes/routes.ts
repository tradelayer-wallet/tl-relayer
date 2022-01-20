import { FastifyInstance } from "fastify";
import { addressRoute } from "./address.route";
import { tokenRoute } from "./token.route";
import { txRoute } from "./tx.route";

export const handleRoutes = (server: FastifyInstance) => {
    server.register(addressRoute, { prefix: '/address' });
    server.register(txRoute, { prefix: '/tx' });
    server.register(tokenRoute, { prefix: '/token' });

}