import { FastifyInstance } from "fastify";
import { getTx } from "../services/tx.service";

export const txRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/:txid', async (request, reply) => {
        try {
            const { txid } = request.params as { txid: string };
            const res = await getTx(txid);
            reply.send(res);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
}