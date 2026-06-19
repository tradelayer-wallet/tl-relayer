import { FastifyInstance } from "fastify";
import { callAllocatedRpc, callRpc, importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { recordTradeLayerRpcSnapshot } from "../services/watchonly-registry.service";
import { ELogType, saveLog } from "../services/utils.service";
import { Encode } from "../services/txEncoder";

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export const rpcRoutes = (fastify: FastifyInstance, _opts: any, done: any) => {
  // Explicit routes
  fastify.post("/payload", handlePayload);
  fastify.post("/allocated/:providerNodeId/:method", handleAllocatedRpc);
  fastify.post("/tl_getAttestations", handleGetAttestations);
  fastify.post("/tl_getChannelColumn", handleGetChannelColumn);
  fastify.post("/tl_listContractSeries", handleListContractSeries);

  // Generic RPC fallback (with special cases)
  fastify.post("/:method", handleGenericRpc);

  done();
};

// -----------------------------------------------------------------------------
// Explicit route handlers
// -----------------------------------------------------------------------------

async function handlePayload(request: any, reply: any) {
  try {
    const { params } = request.body as {
      params?: { type?: string; [key: string]: any };
    };

    if (!params || typeof params.type !== "string") {
      reply.code(400).send({ error: "Missing or invalid params.type" });
      return;
    }

    const encoderType =
      "encode" + params.type.charAt(0).toUpperCase() + params.type.slice(1);

    const fn = (Encode as any)[encoderType];
    if (typeof fn !== "function") {
      reply.code(400).send({ error: `Encoder ${encoderType} not found` });
      return;
    }

    const payload = fn(params);
    reply.send({ payload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("handlePayload error:", msg);
    reply.code(500).send({ error: msg });
  }
}

async function handleListContractSeries(request: any, reply: any) {
  try {
    const body = request.body ?? {};
    const contractId =
      typeof body.contractId === "number"
        ? body.contractId
        : body.params?.contractId;

    if (typeof contractId !== "number") {
      reply.code(400).send({ error: "Missing or invalid contractId" });
      return;
    }

    const res = await callRpc('tl_listcontractseries', { contractId });
    if (res.error) {
      reply.code(502).send({ error: res.error });
      return;
    }
    await recordRouteTradeLayerState({
      method: 'tl_listContractSeries',
      payload: res.data,
      summary: { contractId },
      route: '/tl_listContractSeries',
    });
    reply.send(res.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("handleListContractSeries error:", msg);
    reply.code(500).send({ error: msg });
  }
}

async function handleGetAttestations(request: any, reply: any) {
  try {
    const { address, id } = request.body as {
      address?: string;
      id?: number;
    };

    if (!address || typeof id !== "number") {
      reply.code(400).send({ error: "Invalid address or id" });
      return;
    }

    const res = await callRpc('tl_getattestations', address, id);
    if (res.error) {
      reply.code(502).send({ error: res.error });
      return;
    }
    await recordRouteTradeLayerState({
      method: 'tl_getAttestations',
      payload: res.data,
      address,
      summary: { id },
      route: '/tl_getAttestations',
    });
    reply.send(res.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("handleGetAttestations error:", msg);
    reply.code(500).send({ error: msg });
  }
}

async function handleGetChannelColumn(request: any, reply: any) {
  try {
    const { myAddr, cpAddr } = request.body as {
      myAddr?: string;
      cpAddr?: string;
    };

    if (!myAddr || !cpAddr) {
      reply.code(400).send({ error: "Invalid myAddr or cpAddr" });
      return;
    }

    const res = await callRpc('tl_getchannelcolumn', myAddr, cpAddr);
    if (res.error) {
      reply.code(502).send({ error: res.error });
      return;
    }
    await recordRouteTradeLayerState({
      method: 'tl_getChannelColumn',
      payload: res.data,
      address: myAddr,
      summary: { cpAddr },
      route: '/tl_getChannelColumn',
    });
    reply.send(res.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("handleGetChannelColumn error:", msg);
    reply.code(500).send({ error: msg });
  }
}

// -----------------------------------------------------------------------------
// Generic RPC handler (merged from old router)
// -----------------------------------------------------------------------------

const allowedMethods = [
  "tl_getallbalancesforaddress",
  "tl_getstatesnapshot",
  "tl_listproperties",
  "tl_getproperty",
  "tl_list_attestation",
  "tl_getbalance",
  "tl_getinfo",
  "tl_getclearlistbyid",
  "tl_gettransaction",
  "tl_listcontractseries",
  "tl_getattestations",
  "tl_getchannelcolumn",
  "tl_createrawtx_opreturn",
  "tl_createrawtx_reference",
  "tl_check_kyc",
  "tl_check_commits",
  "tl_listnodereward_addresses",
  "tl_contractPosition",
  "tl_decodetransaction",
  "tl_tokenTradeHistoryForAddress",
  "tl_contractTradeHistoryForAddress",
  "tl_channelBalanceForCommiter",
  "tl_getMaxSynth",
  "tl_createpayload_commit_tochannel",
  "tl_createpayload_withdrawal_fromchannel",
  "tl_createpayload_simplesend",
  "tl_createpayload_attestation",
  "tl_createpayload_instant_ltc_trade",
  "tl_createpayload_instant_trade",
  "tl_createpayload_contract_instant_trade",
  "tl_createpayload_sendactivation",
  "tl_totalTradeHistoryForAddress",
  "tl_getChannel",
  "tl_getInitMargin",
  "tl_getContractInfo",
  "sendrawtransaction",
  "validateaddress",
  "addmultisigaddress",
  "getrawmempool",
].map((method) => method.toLowerCase());

function logPortfolioHeartbeat(event: string, details: Record<string, unknown>) {
  console.log(`[portfolio-heartbeat][relayer][rpc-route] ${event}`, details);
}

async function recordRouteTradeLayerState(input: {
  method: string;
  payload: unknown;
  address?: string | null;
  providerNodeId?: string | null;
  network?: string | null;
  sourceEndpoint?: string | null;
  route?: string | null;
  summary?: Record<string, unknown>;
}) {
  const method = String(input.method || '').trim().toLowerCase();
  if (!method.startsWith('tl_') && method !== 'listunspent') {
    return;
  }
  await recordTradeLayerRpcSnapshot({
    method,
    payload: input.payload,
    address: input.address || null,
    providerNodeId: input.providerNodeId || null,
    network: input.network || null,
    sourceEndpoint: input.sourceEndpoint || null,
    route: input.route || '/rpc/route',
    summary: input.summary || {},
  }).catch((error) => {
    console.warn('[portfolio-heartbeat][relayer][rpc-route] state snapshot failed', {
      method,
      error: error instanceof Error ? error.message : error,
    });
  });
}

function summarizeMethod(method: string, params: any[]): Record<string, unknown> {
  const normalized = String(method || '').trim().toLowerCase();
  const first = params?.[0];
  const second = params?.[1];
  const third = params?.[2];

  if (normalized === 'listunspent' && third && typeof third === 'object') {
    return {
      mappedEndpoint: '/address/utxo',
      address: String(third.address || '').trim(),
      hasPubkey: !!third.pubkey,
      minconf: first,
      maxconf: second,
    };
  }

  if (normalized === 'tl_getallbalancesforaddress') {
    return {
      mappedEndpoint: '/address/balance',
      address: String(first || '').trim(),
    };
  }

  if (normalized === 'tl_listproperties') {
    return { mappedEndpoint: '/token/list' };
  }

  if (normalized === 'tl_getproperty') {
    return {
      mappedEndpoint: '/token/:propid',
      propid: Number(first),
    };
  }

  return { paramsCount: params.length };
}

async function handleAllocatedRpc(request: any, reply: any) {
  try {
    const { providerNodeId, method } = request.params as {
      providerNodeId?: string;
      method?: string;
    };
    const body = request.body ?? {};
    const params = Array.isArray(body.params)
      ? body.params
      : Array.isArray(body?.params?.params)
        ? body.params.params
        : [];
    const network = typeof body.network === 'string' ? body.network : undefined;
    const service = typeof body.service === 'string' ? body.service : undefined;
    const timeoutMs = Number(body.timeoutMs);
    const preferredProviderNodeId = String(body.preferredProviderNodeId || providerNodeId || '').trim() || undefined;

    if (!method) {
      reply.code(400).send({ error: "Missing method" });
      return;
    }

    console.log('[portfolio-heartbeat][relayer][rpc-route] allocated request', {
      method,
      providerNodeId: preferredProviderNodeId || null,
      network: network || null,
      service: service || null,
      paramsCount: params.length,
    });

    const res = await callAllocatedRpc(method, params, {
      preferredProviderNodeId,
      network,
      service,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    });
    if (res.error) {
      reply.code(502).send({ error: res.error });
      return;
    }
    reply.send(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("handleAllocatedRpc error:", msg);
    reply.code(500).send({ error: msg });
  }
}

async function handleGenericRpc(request: any, reply: any) {
logPortfolioHeartbeat('incoming', {
  method: String(request.params?.method || '').trim(),
  contentType: request.headers['content-type'] || null,
  sourceEndpoint: request.body?.sourceEndpoint || null,
});

  try {
    const { method } = request.params as { method: string };
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const params: any[] = Array.isArray(request.body?.params)
      ? request.body.params
      : [];
    const raw = params[0];

    if (
      normalizedMethod === 'tl_getallbalancesforaddress' ||
      normalizedMethod === 'tl_listproperties' ||
      normalizedMethod === 'tl_getproperty'
    ) {
      logPortfolioHeartbeat('mapped-request', {
        method: normalizedMethod,
        sourceEndpoint: request.body?.sourceEndpoint || null,
        ...summarizeMethod(normalizedMethod, params),
      });
    }

    // --- special cases ---

    if (normalizedMethod === "listunspent") {
      const [minconf, maxconf, filter] = params;
      logPortfolioHeartbeat('listunspent-request', {
        minconf,
        maxconf,
        address: String(filter?.address || '').trim(),
        hasPubkey: !!filter?.pubkey,
      });

      if (
        typeof minconf !== "number" ||
        typeof maxconf !== "number" ||
        typeof filter !== "object" ||
        !filter?.address
      ) {
        reply.code(400).send({ error: "Invalid listunspent params" });
        return;
      }

      const typedParams: [number, number, { address: string; pubkey?: string }] = [
        minconf,
        maxconf,
        filter,
      ];

      const res = await listunspent(request.server, typedParams);
      logPortfolioHeartbeat('listunspent-response', {
        hasError: !!res?.error,
        count: Array.isArray(res?.data) ? res.data.length : 0,
      });
      if (!res?.error) {
        await recordRouteTradeLayerState({
          method: 'listunspent',
          payload: res.data,
          address: String(filter?.address || '').trim(),
          summary: {
            minconf,
            maxconf,
            count: Array.isArray(res.data) ? res.data.length : 0,
          },
          route: '/address/utxo',
        });
      }
      reply.send(res);
      return;
    }


    if (normalizedMethod === "tl_getcontractinfo") {
      const contractId = Number(raw?.contractId);
      if (!Number.isInteger(contractId)) {
        reply.code(400).send({ error: "Invalid contractId" });
        return;
      }
      const res = await callRpc('tl_getcontractinfo', { contractId });
      if (res.error) {
        reply.code(502).send({ error: res.error });
        return;
      }
      await recordRouteTradeLayerState({
        method: 'tl_getContractInfo',
        payload: res.data,
        summary: { contractId },
        route: '/tl_getContractInfo',
      });
      reply.send(res.data);
      return;
    }

    if (normalizedMethod === "tl_channelbalanceforcommiter") {
      const address = String(params?.[0] ?? "");
      const propertyId = Number(params?.[1]);
      logPortfolioHeartbeat('tl_channelbalanceforcommiter-request', {
        address: String(address || '').trim(),
        propertyId,
      });
      if (!address || !Number.isInteger(propertyId)) {
        reply
          .code(400)
          .send({ error: "Invalid address or propertyId" });
        return;
      }

      const res = await callRpc('tl_channelbalanceforcommiter', address, propertyId);
      if (res.error) {
        reply.code(502).send({ error: res.error });
        return;
      }
      await recordRouteTradeLayerState({
        method: 'tl_channelBalanceForCommiter',
        payload: res.data,
        address,
        summary: { propertyId },
        route: '/tl_channelBalanceForCommiter',
      });
      logPortfolioHeartbeat('tl_channelbalanceforcommiter-response', {
        address: String(address || '').trim(),
        hasData: !!res?.data,
      });

      reply.send(res.data);
      return;
    }


    if (normalizedMethod === "tl_getinitmargin") {
      const contractId = Number(raw?.contractId);
      const price = Number(raw?.price);
      if (!Number.isInteger(contractId) || !Number.isFinite(price)) {
        reply
          .code(400)
          .send({ error: "Invalid contractId or price" });
        return;
      }
      const res = await callRpc('tl_getinitmargin', { contractId, price });
      if (res.error) {
        reply.code(502).send({ error: res.error });
        return;
      }
      await recordRouteTradeLayerState({
        method: 'tl_getInitMargin',
        payload: res.data,
        summary: { contractId, price },
        route: '/tl_getInitMargin',
      });
      reply.send(res.data);
      return;
    }

    if (normalizedMethod === "tl_tokentradehistoryforaddress") {
      const propertyId1 = params?.[0];
      const propertyId2 = params?.[1];
      const address = String(params?.[2] ?? "");
      if (propertyId1 == null || propertyId2 == null || !address) {
        reply.code(400).send({ error: "Invalid propertyId1, propertyId2, or address" });
        return;
      }
      const res = await callRpc('tl_tokentradehistoryforaddress', propertyId1, propertyId2, address);
      if (res.error) {
        reply.code(502).send({ error: res.error });
        return;
      }
      await recordRouteTradeLayerState({
        method: 'tl_tokenTradeHistoryForAddress',
        payload: res.data,
        address,
        summary: { propertyId1, propertyId2 },
        route: '/tl_tokenTradeHistoryForAddress',
      });
      reply.send(res.data);
      return;
    }

    if (normalizedMethod === "tl_contracttradehistoryforaddress") {
      const contractId = Number(params?.[0]);
      const address = String(params?.[2] ?? params?.[1] ?? "");
      if (!Number.isFinite(contractId) || !address) {
        reply.code(400).send({ error: "Invalid contractId or address" });
        return;
      }
      const res = await callRpc('tl_contracttradehistoryforaddress', contractId, address);
      if (res.error) {
        reply.code(502).send({ error: res.error });
        return;
      }
      await recordRouteTradeLayerState({
        method: 'tl_contractTradeHistoryForAddress',
        payload: res.data,
        address,
        summary: { contractId },
        route: '/tl_contractTradeHistoryForAddress',
      });
      reply.send(res.data);
      return;
    }

    if (normalizedMethod === "tl_totaltradehistoryforaddress") {
      const address = String(params?.[0] ?? "");
      if (!address) {
        reply.code(400).send({ error: "Invalid address" });
        return;
      }
      const res = await callRpc('tl_totaltradehistoryforaddress', address);
      if (res.error) {
        reply.code(502).send({ error: res.error });
        return;
      }
      await recordRouteTradeLayerState({
        method: 'tl_totalTradeHistoryForAddress',
        payload: res.data,
        address,
        route: '/tl_totalTradeHistoryForAddress',
      });
      reply.send(res.data);
      return;
    }

    // --- default passthrough ---

    if (!allowedMethods.includes(normalizedMethod)) {
      reply.code(400).send({ error: `${method} not allowed` });
      return;
    }

    const res = await callRpc(normalizedMethod, ...params);
    if (normalizedMethod === "sendrawtransaction" && res?.data) {
      saveLog(ELogType.TXIDS, res.data);
    }
    if (normalizedMethod === 'tl_getallbalancesforaddress' || normalizedMethod === 'tl_listproperties' || normalizedMethod === 'tl_getproperty') {
      logPortfolioHeartbeat('mapped-response', {
        method: normalizedMethod,
        hasData: res?.data != null,
        hasError: !!res?.error,
      });
    }
    if (!res?.error && (normalizedMethod.startsWith('tl_') || normalizedMethod === 'listunspent')) {
      await recordRouteTradeLayerState({
        method: normalizedMethod,
        payload: res.data,
        address: typeof params?.[0] === 'string' ? String(params[0]).trim() : undefined,
        route: `/rpc/${normalizedMethod}`,
        summary: {
          paramsCount: params.length,
        },
      });
    }
    reply.send(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reply.code(500).send({ error: msg });
  }
}
