import { FastifyInstance, FastifyRequest } from "fastify";
import { getTx, broadcastTx } from "../services/tx.service";

export const txRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/:txid', async (request: FastifyRequest<{ Params: { txid: string } }>, reply) => {
        try {
            const { txid } = request.params;
            const res = await getTx(txid);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    
    // New route to broadcast transactions
    fastify.post('/sendTx', async (request: FastifyRequest<{ Body: { rawTx: string } }>, reply) => {
        try {
            const { rawTx } = request.body;
            const result = await broadcastTx(rawTx);
            reply.send(result);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    done();
};

