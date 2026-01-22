import { FastifyInstance } from "fastify";
import { getTx, sendTx } from "../services/tx.service";

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

    fastify.post('/sendTx', async (request, reply) => {
        try {
          const { rawTx } = request.body as { rawTx: string };

          if (!rawTx) {
            reply.code(400);
            return { error: 'rawtx missing' };
          }

          const result = await sendTx(rawTx);
          return result;

        } catch (err: any) {
          reply.code(500);
          return { error: err.message };
        }
    });

    done();
}