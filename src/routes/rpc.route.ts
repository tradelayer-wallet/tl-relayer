import { FastifyInstance } from "fastify";
import { rpcClient } from "../config/rpc.config"
import { getAttestationPayload } from "../services/address.service";
import { listunspent } from "../services/sochain.service";

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
    //
    'tl_createpayload_commit_tochannel',
    'tl_createpayload_withdrawal_fromchannel',
    'tl_createpayload_simplesend',
    'tl_createpayload_attestation',
    'tl_createpayload_instant_ltc_trade',
    'tl_createpayload_instant_trade',
    'tl_createpayload_contract_instant_trade',
    //
    'createrawtransaction',
    'sendrawtransaction',
    'decoderawtransaction',
    'validateaddress',
    'sendrawtransaction',
    'addmultisigaddress',
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
                const res = await getAttestationPayload(request.ip, fastify);
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
