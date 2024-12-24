import { FastifyInstance } from "fastify";
import { getChainInfo, checkIP  } from "../services/chain.service";

export const chainRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/info', async (request, reply) => {
        try {
            const res = await getChainInfo();
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

 

  fastify.get("/check-ip", async (request, reply) => {
    try {
      const res = await checkIP();
      reply.send(res);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
      reply.status(500).send({ error: errorMessage });
    }
  });

   done();
};

