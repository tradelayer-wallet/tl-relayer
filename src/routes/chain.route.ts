import { FastifyInstance } from "fastify";
import { getChainInfo } from "../services/chain.service";

export const chainRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/info', async (request, reply) => {
        try {
            const res = await getChainInfo();
            reply.send(res);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
}
