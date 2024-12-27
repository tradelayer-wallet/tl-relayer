import { FastifyInstance, FastifyRequest } from "fastify";
import {
    getTx,
    broadcastTx,
    buildTx,
    buildTradeTx,
    buildLTCTradeTx,
    IBuildTxConfig,
    IBuildLTCITTxConfig,
} from "../services/tx.service";

export const txRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    // Get transaction by txid
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

    // Broadcast transaction
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

    // Build generic transaction
   fastify.post('/buildTx', async (request: FastifyRequest<{ Body: { params: IBuildTxConfig } }>, reply) => {
    try {
        const { params } = request.body; // Extract params
        console.log('txConfig:', params); // Log txConfig for debugging
        const result = await buildTx(params, false);
        reply.send(result);
    } catch (error) {
        console.error('Error in /buildTx route:', error);
        reply.status(500).send({ error: 'Failed to build transaction' });
    }
});


    // Build trade transaction
    fastify.post('/buildTradeTx', async (request: FastifyRequest<{ Body: IBuildLTCITTxConfig }>, reply) => {
        try {
            const tradeConfig = request.body;
            const result = await buildTradeTx(tradeConfig);
            reply.send(result);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    // Build LTC trade transaction
    fastify.post('/buildLTCTradeTx', async (request: FastifyRequest<{ Body: IBuildLTCITTxConfig }>, reply) => {
        try {
            const ltcTradeConfig = request.body;
            const result = await buildLTCTradeTx(ltcTradeConfig, false);
            reply.send(result);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    done();
};
