import { FastifyInstance, FastifyRequest } from "fastify";
import {
    getTx,
    broadcastTx,
    decodeTx,
    buildTx,
    buildTradeTx,
    buildLTCTradeTx,
    IBuildTxConfig,
    IBuildLTCITTxConfig,
    computeMultisig
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

    fastify.post('/decode', async (request: FastifyRequest<{ Body: { rawtx: string } }>, reply) => {
        try {
            const { rawtx } = request.body; // Correct to use `body` here
            const res = await decodeTx(rawtx);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });


    // Broadcast transaction
    fastify.post('/sendTx', async (request: FastifyRequest<{ Body: { rawTx: string } }>, reply) => {
        console.log('in sendTx route ' +JSON.stringify(request.body))
        try {
            const { rawTx } = request.body;
            const result = await broadcastTx(rawTx);
            console.log('send response ' +result)
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

    fastify.post('/tx/multisig', async (req, reply) => {
      try {
        const { m, pubKeys, network } = req.body;
    
        if (!Array.isArray(pubKeys) || pubKeys.length < m) {
          throw new Error("Invalid pubkey list or m");
        }
    
        const msData = computeMultisigData(m, pubKeys, network);
    
        reply.send({
          success: true,
          data: msData
        });
      } catch (e: any) {
        reply.send({
          success: false,
          error: e.message
        });
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
    fastify.post('/buildLTCTradeTx', async (request: FastifyRequest<{ Body: { buildLTCITTxConfig: IBuildLTCITTxConfig } }>, reply) => {
  try {
    const { buildLTCITTxConfig } = request.body;

    // Validate required fields
    if (!buildLTCITTxConfig || !buildLTCITTxConfig.buyerKeyPair || !buildLTCITTxConfig.sellerKeyPair) {
      throw new Error('Invalid payload: Missing buyerKeyPair or sellerKeyPair');
    }

    const result = await buildLTCTradeTx(buildLTCITTxConfig, false);
    reply.send(result);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
    reply.status(500).send({ error: errorMessage });
  }
});

    done();
};
