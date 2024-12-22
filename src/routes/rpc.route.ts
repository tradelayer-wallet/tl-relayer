import { FastifyInstance } from "fastify";
import { rpcClient } from "../config/rpc.config"
import { getAttestationPayload, importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { ELogType, saveLog } from "../services/utils.service";

const allowedMethods = [
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
    'validateaddress'
];

export const rpcRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.post('/:method', async (request, reply) => {
        try {
            const { params } = request.body as { params: any[] };
            const { method } = request.params as { method: string };

            if (method === 'listunspent') {
                const res = await listunspent(fastify, params);
                reply.send(res);
                return;
            }

            if (method === 'tl_createpayload_attestation') {
                const res = await getAttestationPayload(fastify, request.ip);
                reply.send(res);
                return;
            }

            if (method === 'importpubkey') {
                const res = await importPubKey(fastify, params);
                reply.send(res);
            }

            if (method === 'sendrawtransaction') {
                const res = await rpcClient.call(method, ...params);
                if (res.data) saveLog(ELogType.TXIDS, res.data);
                reply.send(res);
                return;
            }

            if (!allowedMethods.includes(method)) {
                reply.send({ error: `${method} Method is not allowed` });
                return;
            } else {
                const _params = params?.length ? params : [];
                const res = await rpcClient.call(method, ..._params);
                reply.send(res);
                return;
            }
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
}
