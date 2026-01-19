import { FastifyInstance } from "fastify";
import { rpcClient } from "../config/rpc.config"
import { importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { ELogType, saveLog } from "../services/utils.service";
import axios from "axios";

const allowedMethods = [
    'tl_getallbalancesforaddress',
    'tl_getproperty',
    'tl_list_attestation',
    'tl_getbalance',
    'tl_getinfo',
    'tl_createrawtx_opreturn',
    'tl_createrawtx_reference',
    'tl_check_kyc',
    'tl_check_commits',
    'tl_listnodereward_addresses',
    'tl_getfullposition',
    'tl_decodetransaction',
    'tl_tokenTradeHistoryForAddress',
    'tl_contractTradeHistoryForAddress',
    'tl_channelBalanceForCommiter',
    'tl_getMaxSynth',
    //
    'tl_createpayload_commit_tochannel',
    'tl_createpayload_withdrawal_fromchannel',
    'tl_createpayload_simplesend',
    'tl_createpayload_attestation',
    'tl_createpayload_instant_ltc_trade',
    'tl_createpayload_instant_trade',
    'tl_createpayload_contract_instant_trade',
    'tl_createpayload_sendactivation',
    'tl_totalTradeHistoryForAddress',
    'tl_contractTradeHistoryForAddress',
    'tl_getChannel',
    'tl_getInitMargin',
    'tl_getContractInfo',
    //
    'createrawtransaction',
    'sendrawtransaction',
    'decoderawtransaction',
    'validateaddress',
    'addmultisigaddress',
    'getrawmempool'
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

            
            if (method === 'tl_totalTradeHistoryForAddress') {
              const raw = (request.body as any)?.params?.[0];
              const address = raw?.address;

              if (!address) {
                reply.code(400).send({ error: 'Invalid address' });
                return;
              }

              const res = await axios.get(
                "http://localhost:3000/tl_totalTradeHistoryForAddress",
                { params: { address } }
              );

              reply.send(res.data);
              return;
            }

            
            if (method === 'tl_channelBalanceForCommiter') {
              const raw = (request.body as any)?.params?.[0];
              const address = raw?.address;
              const propertyId = Number(raw?.propertyId);

              if (!address || !Number.isInteger(propertyId)) {
                reply.code(400).send({ error: 'Invalid address or propertyId' });
                return;
              }

              const res = await axios.get(
                "http://localhost:3000/tl_channelBalanceForCommiter",
                { params: { address, propertyId } }
              );

              reply.send(res.data);
              return;
            }

            if (method === 'tl_getChannel') {
              const raw = (request.body as any)?.params?.[0];
              const address = raw?.address;

              if (!address) {
                reply.code(400).send({ error: 'Invalid address' });
                return;
              }

              const res = await axios.get(
                "http://localhost:3000/tl_getChannel",
                { params: { address } }
              );

              reply.send(res.data);
              return;
            }


            if (method === 'tl_contractTradeHistoryForAddress') {
                const { address, contractId } = request.query as { address: string; contractId: number };
                const res = await axios.get("http://localhost:3000/tl_contractTradeHistoryForAddress", {
                    params: { address, contractId },
                });
                reply.send(res.data);
                return;
            }

            if (method === 'tl_tokenTradeHistoryForAddress') {
                const { address, propertyId1, propertyId2 } = request.query as { address: string; propertyId1: number, propertyId2:number };
                const res = await axios.get("http://localhost:3000/tl_contractTradeHistoryForAddress", {
                    params: { address, propertyId1, propertyId2 },
                });
                reply.send(res.data);
                return;
            }

            if (method === 'tl_getContractInfo') {
                  const raw = (request.body as any)?.params?.[0]?.contractId;
                  const contractId = Number(raw);

                  if (!Number.isInteger(contractId)) {
                    reply.code(400).send({ error: 'Invalid contractId' });
                    return;
                  }

                  const res = await axios.get(
                    "http://localhost:3000/tl_getContractInfo",
                    { params: { contractId } }
                  );

                  reply.send(res.data);
                  return;
                }

            if (method === 'tl_getInitMargin') {
              const raw = (request.body as any)?.params?.[0];
              const contractId = Number(raw?.contractId);
              const price = Number(raw?.price);

              if (!Number.isInteger(contractId) || !Number.isFinite(price)) {
                reply.code(400).send({ error: 'Invalid contractId or price' });
                return;
              }

              const res = await axios.get(
                "http://localhost:3000/tl_getInitMargin",
                { params: { contractId, price } }
              );

              reply.send(res.data);
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
