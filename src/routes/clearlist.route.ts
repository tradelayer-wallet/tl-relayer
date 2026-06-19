import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as bitcoin from "bitcoinjs-lib";
import { callRpc } from "../services/address.service";

type Body = {
  groupId?: string;
  listId?: number;
  clearlistId?: number;
  address?: string;
  pubkeyHex?: string;
  optIn?: boolean;
};

function parseGroupMap(): Record<string, number> {
  const raw = process.env.CLEARLIST_GROUP_MAP_JSON;
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j as any)) {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0) out[String(k)] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function parseNonNegativeInt(v: any): number | null {
  if (typeof v === "number") {
    if (Number.isInteger(v) && v >= 0) return v;
    return null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function resolveClearlistId(body: Body, groupMap: Record<string, number>): {
  clearlistId: number | null;
  groupId?: string;
  reason?: "invalid_clearlist_id" | "group_unmapped";
} {
  const explicit = parseNonNegativeInt((body as any).clearlistId);
  if (explicit !== null) return { clearlistId: explicit };

  const listId = parseNonNegativeInt((body as any).listId);
  if (listId !== null) return { clearlistId: listId };

  const groupIdRaw = body.groupId != null ? String(body.groupId) : "";
  const groupId = groupIdRaw.trim();
  if (!groupId) return { clearlistId: null, reason: "invalid_clearlist_id" };

  if (Object.prototype.hasOwnProperty.call(groupMap, groupId)) {
    return { clearlistId: groupMap[groupId], groupId };
  }

  const numericGroup = parseNonNegativeInt(groupId);
  if (numericGroup !== null) return { clearlistId: numericGroup, groupId };

  return { clearlistId: null, groupId, reason: "group_unmapped" };
}

function litecoinNetworkFromEnv(): bitcoin.networks.Network {
  // Minimal network params for P2PKH derivation from pubkey.
  const isTest = String(process.env.NETWORK || "").toUpperCase().includes("TEST");
  if (isTest) return bitcoin.networks.testnet;

  return {
    messagePrefix: "\x19Litecoin Signed Message:\n",
    bech32: "ltc",
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0,
  };
}

function pubkeyToP2pkhAddress(pubkeyHex: string): string | null {
  try {
    const pubkey = Buffer.from(String(pubkeyHex).trim(), "hex");
    if (pubkey.length !== 33 && pubkey.length !== 65) return null;
    const { address } = bitcoin.payments.p2pkh({ pubkey, network: litecoinNetworkFromEnv() });
    return address || null;
  } catch {
    return null;
  }
}

function isOptedIn(req: FastifyRequest, body: Body): boolean {
  const hdr = String((req.headers as any)["x-tl-clearlist-optin"] || "").trim();
  const headerOk = hdr === "1" || hdr.toLowerCase() === "true";
  const bodyOk = body?.optIn === true;
  return headerOk && bodyOk;
}

export async function registerClearlistRoutes(server: FastifyInstance) {
  server.get("/map", async () => {
    const enabled = String(process.env.CLEARLIST_CHECK_ENABLE || "") === "1";
    const map = parseGroupMap();
    return { enabled, groupMap: map };
  });

  server.get(
    "/admin/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 0) {
        reply.code(400);
        return { error: "invalid_clearlist_id" };
      }

      const res = await callRpc("tl_getclearlistbyid", id);
      if (res.error) {
        reply.code(502);
        return { error: res.error, clearlistId: id };
      }
      const data: any = res?.data;

      if (!data) {
        reply.code(404);
        return { error: "not_found", clearlistId: id };
      }

      const adminAddress = data.adminAddress || data.admin || data.admin_address || null;
      const backupAddress = data.backupAddress || data.backup || null;
      const name = data.name || null;

      return {
        clearlistId: id,
        adminAddress,
        backupAddress,
        name,
      };
    }
  );

  server.post(
    "/check",
    async (req: FastifyRequest<{ Body: Body }>, reply: FastifyReply) => {
      const enabled = String(process.env.CLEARLIST_CHECK_ENABLE || "") === "1";
      if (!enabled) {
        reply.code(404);
        return { allowed: false, enabled: false, reason: "disabled" };
      }

      const body = (req.body || {}) as Body;
      if (!isOptedIn(req, body)) {
        reply.code(400);
        return { allowed: false, enabled: true, reason: "not_opted_in" };
      }

      const groupMap = parseGroupMap();
      const resolved = resolveClearlistId(body, groupMap);
      const listId = resolved.clearlistId;
      const groupId = resolved.groupId;

      if (listId == null || !Number.isInteger(listId) || listId < 0) {
        reply.code(400);
        return {
          allowed: false,
          enabled: true,
          reason: resolved.reason || "invalid_clearlist_id",
          groupId: groupId || undefined,
        };
      }

      const address =
        (body.address && String(body.address).trim()) ||
        (body.pubkeyHex ? pubkeyToP2pkhAddress(body.pubkeyHex) : null);

      if (!address) {
        reply.code(400);
        return { allowed: false, enabled: true, reason: "missing_address" };
      }

      const res = await callRpc("tl_getattestations", address, listId);
      if (res.error) {
        reply.code(502);
        return {
          allowed: false,
          enabled: true,
          reason: res.error,
          clearlistId: listId,
          listId,
          groupId: groupId || undefined,
          address,
        };
      }
      const data: any = res?.data;

      // Common shapes: boolean, {allowed}, {data:true}, {attestations:[...]}
      const allowed =
        data === true ||
        data?.allowed === true ||
        data?.data === true ||
        (Array.isArray(data?.attestations) && data.attestations.length > 0) ||
        (Array.isArray(data) && data.length > 0);

      return {
        allowed: !!allowed,
        enabled: true,
        clearlistId: listId,
        listId,
        groupId: groupId || undefined,
        address,
      };
    }
  );
}
