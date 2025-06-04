import { FastifyInstance } from "fastify";
import axios from "axios";
import { rpcClient } from "../config/rpc.config";
import { importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { ELogType, saveLog } from "../services/utils.service";
import { Encode } from "../services/txEncoder"; // Correct import for Encode

export const rpcRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    // Define routes explicitly
    fastify.post('/payload', handlePayload);
    fastify.post('/tl_getAttestations', handleGetAttestations);
    fastify.post('tl_getChannelColumn', handleGetChannelColumn)
    fastify.post('/:method', handleGenericRpc);
    fastify.post('/tl_listContractSeries', handleListContractSeries)

    done();
};

/**
 * Handles the "payload" route.
 */
async function handlePayload(request: any, reply: any) {
    try {
        const { params } = request.body as { params: { type?: string; [key: string]: any } };

        if (!params || typeof params.type !== "string") {
            reply.status(400).send({ error: `Invalid 'params' or missing 'type' in payload request.` });
            return;
        }

        const encoderType = `encode${params.type.charAt(0).toUpperCase() + params.type.slice(1)}`;

        if (typeof Encode[encoderType as keyof typeof Encode] === 'function') {
            const payload = (Encode[encoderType as keyof typeof Encode] as Function)(params);
            reply.send({ payload });
        } else {
            reply.status(400).send({ error: `Encoding method '${encoderType}' not found.` });
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error in payload encoding:`, errorMessage);
        reply.status(500).send({ error: `Error encoding payload: ${errorMessage}` });
    }
}

// Handler for POST /tl_listContractSeries
async function handleListContractSeries(
    request: any,
    reply: any
) {
    try {
        // Accept both top-level and params contractId
        let contractId: number | undefined;

        if ('contractId' in request.body && request.body.contractId !== undefined) {
            contractId = request.body.contractId;
        } else if ('params' in request.body && request.body.params?.contractId !== undefined) {
            contractId = request.body.params.contractId;
        }

        if (typeof contractId !== 'number') {
            reply.status(400).send({ error: "Missing or invalid contractId" });
            return;
        }

        // Forward to listener
        console.log('about to call list contract series '+contractId)
        const axiosRes = await axios.post('http://localhost:3000/tl_listContractSeries', { contractId });
        reply.send(axiosRes.data);

    } catch (error) {
        console.error('Error in handleListContractSeries:', error);
        const message = error instanceof Error ? error.message : String(error);
        reply.status(500).send({ error: message || "Unknown error" });
    }
}

/**
 * Handles the "tl_getAttestations" route.
 */
async function handleGetAttestations(request: any, reply: any) {
    try {
        const { address, id } = request.body as { address: string; id: number };

        if (!address || typeof address !== "string") {
            reply.status(400).send({ error: 'Invalid or missing "address" parameter.' });
            return;
        }
        if (id === undefined || typeof id !== "number") {
            reply.status(400).send({ error: 'Invalid or missing "id" parameter.' });
            return;
        }

        // Forward to the localhost service
        const response = await axios.post(`http://localhost:3000/tl_getAttestations`, { address, id });
        reply.send(response.data);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error in tl_getAttestations:`, errorMessage);
        reply.status(500).send({ error: `Error forwarding tl_getAttestations: ${errorMessage}` });
    }
}


async function handleGetChannelColumn(request: any, reply: any) {
    try {
        const { myAddr, cpAddr } = request.body as { myAddr: string; cpAddr: string };

        if (!myAddr || typeof myAddr !== "string") {
            reply.status(400).send({ error: 'Invalid or missing "address" parameter.' });
            return;
        }
        if (cpAddr === undefined || typeof cpAddr!== "number") {
            reply.status(400).send({ error: 'Invalid or missing "id" parameter.' });
            return;
        }

        // Forward to the localhost service
        const response = await axios.post(`http://localhost:3000/tl_getChannelColumn`, { myAddr, cpAddr });
        reply.send(response.data);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error in tl_getAttestations:`, errorMessage);
        reply.status(500).send({ error: `Error forwarding tl_getAttestations: ${errorMessage}` });
    }
}

/**
 * Handles generic RPC calls for allowed methods.
 */
async function handleGenericRpc(request: any, reply: any) {
    try {
        const { params } = request.body as { params: any[] };
        const { method } = request.params as { method: string };

        // Validate allowed methods
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
        ];

        if (!allowedMethods.includes(method)) {
            reply.status(400).send({ error: `${method} Method is not allowed.` });
            return;
        }

        // Special case for "sendrawtransaction"
        if (method === "sendrawtransaction") {
            const res = await rpcClient.call(method, ...(params as any[]));
            if (res.data) saveLog(ELogType.TXIDS, res.data);
            reply.send(res);
            return;
        }

        if (method === "tl_listContractSeries") {
            console.log('params in tl_listContractSeries call ' + JSON.stringify(params));
            let payload: any;

            if (params && typeof params === "object" && !Array.isArray(params) && "contractId" in params) {
                // params is an object with contractId property
                payload = { contractId: (params as { contractId: any }).contractId };
            } else if (Array.isArray(params) && params.length > 0) {
                // params is an array, use first element
                payload = { contractId: params[0] };
            } else {
                payload = {};
            }

            const response = await axios.post(`http://localhost:3000/${method}`, payload);
            console.log('response ' + JSON.stringify(response.data));
            reply.send(response.data);
            return;
        }

        // Forward "tl_" prefixed methods to localhost:3000
        if (method.startsWith("tl_")) {
            console.log('params in tl method call '+JSON.stringify(params))
            const response = await axios.post(`http://localhost:3000/${method}`, { params });
            console.log('response '+JSON.stringify(response))
            reply.send(response.data);
            return;
        }

        // Default RPC client call
        const res = await rpcClient.call(method, ...(params || []));
        reply.send(res);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error in RPC method ${request.params.method}:`, errorMessage);
        reply.status(500).send({ error: errorMessage });
    }
}
