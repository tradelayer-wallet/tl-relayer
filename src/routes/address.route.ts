import { FastifyInstance } from "fastify";
import { getAddressBalance, validateAddress } from "../services/address.service";

export const addressRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/validate/:address', async (request, reply) => {
        try {
            const { address } = request.params as { address: string };
            const res = await validateAddress(address);
            reply.send(res);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    fastify.get('/balance/:address', async (request, reply) => {
        try {
            const { address } = request.params as { address: string };
            const res = await getAddressBalance(address);
            reply.send(res);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
}