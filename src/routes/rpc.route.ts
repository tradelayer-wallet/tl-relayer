import { FastifyInstance } from "fastify";
import { callAllocatedRpc, callRpc } from "../services/address.service";
import { recordTradeLayerRpcSnapshot, watchOnlyRegistrationError } from "../services/watchonly-registry.service";
import { Encode } from "../services/txEncoder";

const PUBLIC_RPC_METHODS = new Set([
  'tl_getstatesnapshot',
  'tl_watchonly_register',
  'tl_watchonly_utxos',
  'tl_getsyncstatus',
  'tl_getallbalancesforaddress',
  'tl_getchannel',
  'tl_getchannelcolumn',
  'tl_getcontractinfo',
  'tl_getattestations',
  'tl_gettransaction',
  'tl_getclearlistbyid',
  'tl_listcontractseries',
  'tl_getinitmargin',
  'tl_channelbalanceforcommiter',
  'tl_getmaxsynth',
  'tl_contractposition',
  'tl_tokentradehistoryforaddress',
  'tl_contracttradehistoryforaddress',
  'tl_totaltradehistoryforaddress',
  'tl_getinfo',
  'tl_getbalance',
  'tl_getproperty',
  'tl_listproperties',
  'tl_createpayload_attestation',
  'tl_createpayload_commit_tochannel',
]);

const ALLOWED_PAYLOAD_ENCODERS: Record<string, keyof typeof Encode> = {
  attestation: 'encodeAttestation',
  issueorrevokeattestation: 'encodeAttestation',
  commit: 'encodeCommit',
  commitchannel: 'encodeCommit',
  commit_tochannel: 'encodeCommit',
};

function normalizeRpcMethod(method: unknown): string {
  return String(method || '').trim().toLowerCase();
}

function sendRpcError(reply: any, statusCode: number, code: string, message: string) {
  reply.code(statusCode).send({ error: { code, message } });
}

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
      sendRpcError(reply, 400, 'BAD_PAYLOAD_REQUEST', 'Missing or invalid params.type');
      return;
    }

    const encoderType = ALLOWED_PAYLOAD_ENCODERS[normalizeRpcMethod(params.type)];

    const fn = encoderType ? (Encode as any)[encoderType] : undefined;
    if (typeof fn !== "function") {
      sendRpcError(reply, 403, 'PAYLOAD_TYPE_FORBIDDEN', 'Payload type is not available on the public mesh');
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
    const body = request.body ?? {};
    const params = Array.isArray(body.params) ? body.params : [];
    const channelAddress = body.channelAddress || body.channel || params[0];
    const newCommitAddress = body.newCommitAddress || body.myAddress || body.myAddr || body.buyerAddress || params[1];
    const cpAddress = body.cpAddress || body.cpAddr || params[2];

    if (!channelAddress || !newCommitAddress || !cpAddress) {
      reply.code(400).send({ error: "channelAddress, newCommitAddress, and cpAddress are required" });
      return;
    }

    const res = await callRpc('tl_getchannelcolumn', channelAddress, newCommitAddress, cpAddress);
    if (res.error) {
      reply.code(502).send({ error: res.error });
      return;
    }
    await recordRouteTradeLayerState({
      method: 'tl_getChannelColumn',
      payload: res.data,
      address: newCommitAddress,
      summary: { channelAddress, cpAddress },
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

    const normalizedMethod = normalizeRpcMethod(method);
    if (!normalizedMethod) {
      sendRpcError(reply, 400, 'BAD_RPC_REQUEST', 'Missing method');
      return;
    }
    if (!PUBLIC_RPC_METHODS.has(normalizedMethod)) {
      sendRpcError(reply, 403, 'RPC_METHOD_FORBIDDEN', 'RPC method is not available on the public mesh');
      return;
    }

    console.log('[portfolio-heartbeat][relayer][rpc-route] allocated request', {
      method: normalizedMethod,
      providerNodeId: preferredProviderNodeId || null,
      network: network || null,
      service: service || null,
      paramsCount: params.length,
    });

    const res = await callAllocatedRpc(normalizedMethod, params, {
      preferredProviderNodeId,
      network,
      service,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    });
    if (res.error) {
      const noProvider = /no WebRTC RPC provider/i.test(String(res.error));
      sendRpcError(reply, noProvider ? 503 : 502, noProvider ? 'NO_RPC_PROVIDER' : 'RPC_UPSTREAM_ERROR', String(res.error));
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
    const normalizedMethod = normalizeRpcMethod(method);
    if (!PUBLIC_RPC_METHODS.has(normalizedMethod)) {
      sendRpcError(reply, 403, 'RPC_METHOD_FORBIDDEN', 'RPC method is not available on the public mesh');
      return;
    }
    let params: any[] = Array.isArray(request.body?.params)
      ? request.body.params
      : [];
    if (
      normalizedMethod === 'tl_getchannel' &&
      params.length === 0 &&
      typeof request.query?.address === 'string' &&
      request.query.address.trim()
    ) {
      params = [request.query.address.trim()];
    }
    const raw = params[0];

    if (normalizedMethod === 'tl_watchonly_register') {
      const account = raw && typeof raw === 'object' ? raw : {};
      const refusal = await watchOnlyRegistrationError({
        address: String(account.address || ''),
        pubkey: String(account.pubkey || account.pubKey || ''),
      });
      if (refusal) {
        sendRpcError(reply, 400, 'WATCHONLY_REGISTRATION_REFUSED', refusal);
        return;
      }
    }

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

    const res = await callRpc(normalizedMethod, ...params);
    if (res?.error) {
      const noProvider = /no WebRTC RPC provider/i.test(String(res.error));
      sendRpcError(reply, noProvider ? 503 : 502, noProvider ? 'NO_RPC_PROVIDER' : 'RPC_UPSTREAM_ERROR', String(res.error));
      return;
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
