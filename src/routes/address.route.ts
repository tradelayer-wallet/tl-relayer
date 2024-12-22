import { FastifyInstance, FastifyRequest } from "fastify";
import { fundAddress, getAddressBalance, validateAddress } from "../services/address.service";

export const addressRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/validate/:address', async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
        try {
            const { address } = request.params;
            const res = await validateAddress(address);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    fastify.get('/balance/:address', async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
        try {
            const { address } = request.params;
            const res = await getAddressBalance(address);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    fastify.get('/faucet/:address', async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
        try {
            const { address } = request.params;
            const res = await fundAddress(address);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    done();
};
