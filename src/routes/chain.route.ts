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

 
fastify.post(
    "/check-ip",
    async (
      request: FastifyRequest<{ Body: { ip: string } }>, // Define the type of request body
      reply
    ) => {
      try {
        const body = request.body as { ip: string }; // Explicitly type-cast request.body
        const { ip } = body;

        if (!ip) {
          reply.status(400).send({ error: "IP address is required" });
          return;
        }

        const res = await checkIP(ip);
        reply.send(res);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
        reply.status(500).send({ error: errorMessage });
      }
    }
  );

   done();
};

