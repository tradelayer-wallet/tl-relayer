import { FastifyInstance, FastifyRequest } from "fastify";
import { fundAddress, getAddressBalance, validateAddress } from "../services/address.service";
import { listunspent } from "../services/sochain.service"; // Import the new function

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

    fastify.get(
            '/utxo/:address',
            async (
                request: FastifyRequest<{
                    Params: { address: string };
                    Querystring: { minBlock?: string; maxBlock?: string; pubkey?: string };
                }>,
                reply
            ) => {
                try {
                    const { address } = request.params;
                    const minBlock = parseInt(request.query.minBlock || "1", 10);
                    const maxBlock = parseInt(request.query.maxBlock || "99999999", 10);
                    const pubkey = request.query.pubkey; // Optional pubkey from the query
        
                    // Pass the properly structured object as the third parameter
                    const res = await listunspent(fastify, [
                        minBlock,
                        maxBlock,
                        { address, pubkey },
                    ]);
        
                    if (res.error) {
                        reply.status(400).send({ error: res.error });
                    } else {
                        reply.send(res.data);
                    }
                } catch (error: unknown) {
                    const errorMessage =
                        error instanceof Error ? error.message : "An unexpected error occurred";
                    reply.status(500).send({ error: errorMessage });
                }
            }
        );

    done();
};
