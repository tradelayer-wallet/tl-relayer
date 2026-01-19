import { FastifyInstance } from "fastify";
import axios from "axios";

import { rpcClient } from "../config/rpc.config";
import { importPubKey } from "../services/address.service";
import { listunspent } from "../services/sochain.service";
import { ELogType, saveLog } from "../services/utils.service";
import { Encode } from "../services/txEncoder";

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export const rpcRoutes = (fastify: FastifyInstance, _opts: any, done: any) => {
  // Explicit routes
  fastify.post("/payload", handlePayload);
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

    const res = await axios.post(
      "http://localhost:3000/tl_listContractSeries",
      { contractId }
    );
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

    const res = await axios.post(
      "http://localhost:3000/tl_getAttestations",
      { address, id }
    );
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

    const res = await axios.post(
      "http://localhost:3000/tl_getChannelColumn",
      { myAddr, cpAddr }
    );
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
  "tl_getproperty",
  "tl_list_attestation",
  "tl_getbalance",
  "tl_getinfo",
  "tl_createrawtx_opreturn",
  "tl_createrawtx_reference",
  "tl_check_kyc",
  "tl_check_commits",
  "tl_listnodereward_addresses",
  "tl_getfullposition",
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
  "createrawtransaction",
  "sendrawtransaction",
  "decoderawtransaction",
  "validateaddress",
  "addmultisigaddress",
  "getrawmempool",
];

async function handleGenericRpc(request: any, reply: any) {
  try {
    const { method } = request.params as { method: string };
    const params: any[] = Array.isArray(request.body?.params)
      ? request.body.params
      : [];
    const raw = params[0];

    // --- special cases ---

    if (method === "listunspent") {
      const res = await listunspent(request.server, params);
      reply.send(res);
      return;
    }

    if (method === "tl_getContractInfo") {
      const contractId = Number(raw?.contractId);
      if (!Number.isInteger(contractId)) {
        reply.code(400).send({ error: "Invalid contractId" });
        return;
      }
      const res = await axios.get(
        "http://localhost:3000/tl_getContractInfo",
        { params: { contractId } }
      );
      reply.send(res.data);
      return;
    }

    if (method === "tl_getInitMargin") {
      const contractId = Number(raw?.contractId);
      const price = Number(raw?.price);
      if (!Number.isInteger(contractId) || !Number.isFinite(price)) {
        reply
          .code(400)
          .send({ error: "Invalid contractId or price" });
        return;
      }
      const res = await axios.get(
        "http://localhost:3000/tl_getInitMargin",
        { params: { contractId, price } }
      );
      reply.send(res.data);
      return;
    }

    // --- default passthrough ---

    if (!allowedMethods.includes(method)) {
      reply.code(400).send({ error: `${method} not allowed` });
      return;
    }

    const res = await rpcClient.call(method, ...params);
    if (method === "sendrawtransaction" && res?.data) {
      saveLog(ELogType.TXIDS, res.data);
    }
    reply.send(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reply.code(500).send({ error: msg });
  }
}
