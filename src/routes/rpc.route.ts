import { FastifyInstance } from "fastify";
import axios from "axios";
import { rpcClient } from "../config/rpc.config";
import { getAttestationPayload, importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { ELogType, saveLog } from "../services/utils.service";
import { Encode } from "../services/txEncoder";

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
            const { params } = request.body as { params: any[] };
            const { method } = request.params as { method: string };

             // If the method is 'payload', handle encoding
            if (method === 'payload') {
                if (const { params } = request.body as { params: { type?: string; [key: string]: any } };) {
                    reply.status(400).send({ error: `Missing 'type' parameter in payload request.` });
                    return;
                }

                const encoderType = `encode${params.type.charAt(0).toUpperCase() + params.type.slice(1)}`;
                if (typeof Encode[encoderMethod] === 'function') {
                    try {
                        const payload = Encode[encoderType](params);
                        reply.send({ payload });
                        return;
                    } catch (encodingError) {
                        reply.status(500).send({ error: `Error encoding payload: ${encodingError.message}` });
                        return;
                    }
                } else {
                    reply.status(400).send({ error: `Encoding method '${encoderMethod}' not found.` });
                    return;
                }
            }
            
            // Forward "tl_" prefixed methods to localhost:3000
            if (method.startsWith("tl_")) {
                try {
                    const response = await axios.post(`http://localhost:3000/${method}`, { params });
                    reply.send(response.data);
                    return;
                } catch (axiosError) {
                    console.error(`Error forwarding ${method}:`, axiosError);
                    reply.status(500).send({ error: `Error forwarding ${method}: ${axiosError.message}` });
                    return;
                }
            }

            // Handle specific methods locally
            if (method === "listunspent") {
                const res = await listunspent(fastify, params);
                reply.send(res);
                return;
            }

            if (method === "tl_createpayload_attestation") {
                const res = await getAttestationPayload(fastify, request.ip);
                reply.send(res);
                return;
            }

            if (method === "importpubkey") {
                const res = await importPubKey(fastify, params);
                reply.send(res);
                return;
            }

            if (method === "sendrawtransaction") {
                const res = await rpcClient.call(method, ...params);
                if (res.data) saveLog(ELogType.TXIDS, res.data);
                reply.send(res);
                return;
            }

            // Check if method is allowed
            if (!allowedMethods.includes(method)) {
                reply.status(400).send({ error: `${method} Method is not allowed` });
                return;
            }

            // Default RPC client call
            const _params = params?.length ? params : [];
            const res = await rpcClient.call(method, ..._params);
            reply.send(res);
        } catch (error) {
            console.error(`Error in RPC route for method ${request.params.method}:`, error);
            reply.status(500).send({ error: error.message });
        }
    });

    done();
};
