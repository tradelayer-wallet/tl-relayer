import { FastifyInstance, FastifyRequest } from "fastify";
import { getTokenInfo, listTokens } from "../services/token.service";

export const tokenRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/list', async (request, reply) => {
        try {
            const res = await listTokens();
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    fastify.get('/:propid', async (request: FastifyRequest<{ Params: { propid: string } }>, reply) => {
        try {
            const { propid } = request.params;
            const _propid = parseInt(propid);
            const res = await getTokenInfo(_propid);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    done();
};
