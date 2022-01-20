import { FastifyInstance } from "fastify";
import { getTokenInfo, listTokens } from "../services/token.service";

export const tokenRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/list', async (request, reply) => {
        try {
            const res = await listTokens();
            reply.send(res);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    fastify.get('/:propid', async (request, reply) => {
        try {
            const { propid } = request.params as { propid: string };
            const _propid = parseInt(propid);
            const res = await getTokenInfo(_propid);
            reply.send(res);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
}