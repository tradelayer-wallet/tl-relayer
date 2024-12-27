import { FastifyInstance, FastifyRequest } from "fastify";
import { getTx, broadcastTx, buildTx, buildTradeTx, buildLTCTradeTx } from "../services/tx.service";

// Placeholder for buildTradeTx - You need to implement this in your service.
const buildTradeTx = async (tradeConfig: any) => {
    // Implement the logic for building trade transactions.
    return { data: "TradeTx not implemented yet" };
};

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
 fastify.post('/buildTx', async (request: FastifyRequest<{ Body: IBuildTxConfig }>, reply) => {
    try {
        const txConfig = request.body;
        const result = await buildTx(txConfig, true);
        reply.send(result);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        reply.status(500).send({ error: errorMessage });
    }
});


    // Build trade transaction (yet to be implemented)
    fastify.post('/buildTradeTx', async (request: FastifyRequest<{ Body: any }>, reply) => {
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
    fastify.post('/buildLTCTradeTx', async (request: FastifyRequest<{ Body: any }>, reply) => {
        try {
            const ltcTradeConfig = request.body;
            const result = await buildLTCTradeTx(ltcTradeConfig, true);
            reply.send(result);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    done();
};
