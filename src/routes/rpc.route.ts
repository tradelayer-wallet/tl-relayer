import { FastifyInstance } from "fastify";
import axios from "axios";
import { rpcClient } from "../config/rpc.config";
import { importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { ELogType, saveLog } from "../services/utils.service";
import { Encode } from "../services/txEncoder"; // Correct import for Encode

const allowedMethods = [
    'tl_initmain',
    'tl_validateaddress',
    'tl_getTransaction',
    'tl_getChannelColumn',
    'tl_getAttestations',
    'tl_loadWallet',
    'tl_gettransactionsforaddress',
    'tl_gettransactionforblock',
    'tl_getMaxProcessedHeight',
    'tl_getMaxParsedHeight',
    'tl_getTrackHeight',
    'tl_checkSync',
    'tl_pause',
    'tl_getAllBalancesForAddress',
    'tl_getChannel',
    'tl_createrawtx_opreturn',
    'tl_getProperty',
    'tl_listProperties',
    'tl_listClearlists',
    'tl_showClearlist',
    'tl_listFeeCache',
    'tl_propertyFeeCache',
    'tl_getActivations',
    'tl_getOrderbook',
    'tl_getContractOrderbook',
    'tl_listContractSeries',
    'tl_listOracles',
    'tl_contractPosition',
    'tl_tradeHistory',
    'tl_getInitMargin',
    'tl_contractTradeHistory',
    'tl_fundingHistory',
    'tl_oracleHistory',
    'sendrawtransaction',
    'decoderawtransaction',
    'validateaddress',
    'payload'
];

export const rpcRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.post('/:method', async (request, reply) => {
        try {
            // Extract parameters and method from the request
            const { params } = request.body as { params: { type?: string; [key: string]: any } | any[] };
            const { method } = request.params as { method: string };

            // If the method is 'payload', handle encoding
            if (method === 'payload') {
                if (!params?.type || typeof params?.type !== "string") {
                    reply.status(400).send({ error: `Missing or invalid 'type' parameter in payload request.` });
                    return;
                }

                const encoderType = `encode${params.type.charAt(0).toUpperCase() + params.type.slice(1)}`;

                if (typeof Encode[encoderType as keyof typeof Encode] === 'function') {
                    try {
                        const payload = (Encode[encoderType as keyof typeof Encode] as Function)(params);
                        reply.send({ payload });
                        return;
                    } catch (encodingError: unknown) {
                        const errorMessage = encodingError instanceof Error ? encodingError.message : 'Unknown error';
                        reply.status(500).send({ error: `Error encoding payload: ${errorMessage}` });
                        return;
                    }
                } else {
                    reply.status(400).send({ error: `Encoding method '${encoderType}' not found.` });
                    return;
                }
            }

            // Forward "tl_" prefixed methods to localhost:3000
            if (method.startsWith("tl_")) {
                try {
                    const response = await axios.post(`http://localhost:3000/${method}`, { params });
                    reply.send(response.data);
                    return;
                } catch (axiosError: unknown) {
                    const errorMessage = axiosError instanceof Error ? axiosError.message : 'Unknown error';
                    console.error(`Error forwarding ${method}:`, errorMessage);
                    reply.status(500).send({ error: `Error forwarding ${method}: ${errorMessage}` });
                    return;
                }
            }

            // Other specific methods
            if (method === "listunspent") {
                const res = await listunspent(fastify, params as any[]);
                reply.send(res);
                return;
            }

            if (method === "importpubkey") {
                const res = await importPubKey(fastify, params as any[]);
                reply.send(res);
                return;
            }

            if (method === "sendrawtransaction") {
                const res = await rpcClient.call(method, ...(params as any[]));
                if (res.data) saveLog(ELogType.TXIDS, res.data);
                reply.send(res);
                return;
            }

            // Default RPC client call
            if (!allowedMethods.includes(method)) {
                reply.status(400).send({ error: `${method} Method is not allowed` });
                return;
            }

            const _params = Array.isArray(params) ? params : [];
            const res = await rpcClient.call(method, ..._params);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`Error in RPC route for method ${request.params.method}:`, errorMessage);
            reply.status(500).send({ error: errorMessage });
        }
    });

    done();
};
