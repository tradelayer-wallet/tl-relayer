import { FastifyInstance } from "fastify";
import { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { envConfig } from "../config/env.config";
import {
  INTERNAL_RELAY_AUTH_HEADER,
  INTERNAL_RELAY_AUTH_TOKEN,
  scrubSensitiveQuery,
  secureCompare,
} from "./security-utils.service";

type WsRelayRequest = {
  id?: string;
  method?: string;
  path?: string;
  query?: Record<string, any>;
  body?: any;
  headers?: Record<string, string>;
};

const jsonReply = (ws: WebSocket, payload: Record<string, unknown>) => {
  ws.send(JSON.stringify(payload));
};

// Issue #1 / M2+H3: client-supplied headers that can spoof the connection
// metadata or credentials must never reach the internal Fastify instance.
// The WS handshake is the credential gate for this surface, so the client's
// x-api-key is not forwarded (the relay presents its own internal marker
// instead). x-admin-api-key is forwarded on purpose (issue #1 round 2 / NEW-6):
// the faucet needs it, and the faucet handler verifies it.
const STRIPPED_RELAY_HEADERS = new Set([
  "host",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "x-api-key",
  "authorization",
  "cookie",
  INTERNAL_RELAY_AUTH_HEADER,
]);

const buildRelayHeaders = (clientHeaders?: Record<string, string>) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [key, value] of Object.entries(clientHeaders || {})) {
    const name = String(key || "").toLowerCase();
    if (!name || STRIPPED_RELAY_HEADERS.has(name)) continue;
    if (typeof value === "string") headers[name] = value;
  }
  // Issue #1 / M2: the client key is validated once at WS handshake; the
  // internal inject path then authenticates with the per-process relay marker
  // that the API-key hook accepts only from this in-process relay.
  headers[INTERNAL_RELAY_AUTH_HEADER] = INTERNAL_RELAY_AUTH_TOKEN;
  return headers;
};

const normalizePath = (path: string) => {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
};

const withQuery = (path: string, query?: Record<string, any>) => {
  if (!query || typeof query !== "object") return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

export class WsRelayService {
  private wss: WebSocketServer;

  constructor(private app: FastifyInstance) {
    this.wss = new WebSocketServer({ noServer: true });
    this.attachUpgradeHandler();
  }

  private attachUpgradeHandler() {
    this.app.server.on("upgrade", (req, socket, head) => {
      const url = this.safeParseUrl(req);
      if (!url || !url.pathname.startsWith("/ws")) return;

      // Issue #1 / M2: authenticate the WS client at handshake (fix for the
      // ws-relay auth regression). Browsers cannot set WebSocket request
      // headers, so the key may arrive as `x-api-key` or as an `apiKey` query
      // parameter on the upgrade URL.
      if (!this.isHandshakeAuthorized(req, url)) {
        // Issue #1 round 2 / NEW-3: the request target is logged only with its
        // credential query values redacted.
        console.warn(
          `[security] WS handshake rejected for ${scrubSensitiveQuery(req.url || url.pathname, "redact")}`
        );
        const body = JSON.stringify({ error: "Missing or invalid x-api-key header" });
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\n" +
            "Connection: close\r\n" +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "\r\n" +
            body
        );
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, url.pathname);
      });
    });
  }

  private isHandshakeAuthorized(req: IncomingMessage, url: URL): boolean {
    const apiKey = envConfig.RELAYER_API_KEY;
    if (!apiKey) return true;
    // Issue #1 round 2 / NEW-3: browsers cannot set WebSocket request headers,
    // so `?apiKey=` is accepted for compatibility. Tradeoff: a key in the URL can
    // reach proxy/server access logs and browser history outside this process.
    // Within this process the value is redacted from logged URLs (see
    // scrubSensitiveQuery and the request-log serializer in index.ts); clients
    // that can set headers should send `x-api-key` instead.
    const provided = String(
      (req.headers["x-api-key"] as string) || url.searchParams.get("apiKey") || ""
    );
    return !!provided && secureCompare(provided, apiKey);
  }

  private safeParseUrl(req: IncomingMessage): URL | null {
    try {
      const host = req.headers.host || "localhost";
      const raw = req.url || "/";
      return new URL(raw, `http://${host}`);
    } catch {
      return null;
    }
  }

  private handleConnection(ws: WebSocket, wsPathname: string) {
    const boundPath = normalizePath(wsPathname.replace(/^\/ws/, ""));
    // Round 6 / F-A1: ws emits 'error' on protocol violations (for example an unmasked
    // client frame). With no listener that event throws and takes the whole relayer
    // down, so a single bad frame must only close its own connection.
    ws.on("error", () => ws.terminate());
    jsonReply(ws, { event: "connected", boundPath });

    ws.on("message", async (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      let payload: WsRelayRequest;

      try {
        payload = JSON.parse(text);
      } catch {
        jsonReply(ws, { ok: false, error: "Invalid JSON payload" });
        return;
      }

      // Round 6 / F-A1: `null`, numbers and arrays are valid JSON but not requests.
      // Reading `.id` off `null` used to throw outside the try block below and crash
      // the process through an unhandled promise rejection.
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        jsonReply(ws, { ok: false, statusCode: 400, error: "Invalid request payload" });
        return;
      }

      const id = payload.id;
      try {
        const method = (payload.method || (payload.body ? "POST" : "GET")).toUpperCase();
        const targetPath = normalizePath(payload.path || boundPath);
        // Issue #1 round 2 / NEW-3: credential-bearing query params must not reach
        // the internal inject URL, where the Fastify request log would record them.
        const targetUrl = scrubSensitiveQuery(withQuery(targetPath, payload.query), "remove");

        const response: any = await (this.app as any).inject({
          method,
          url: targetUrl,
          payload: payload.body,
          headers: buildRelayHeaders(payload.headers),
        });

        const bodyText = response.payload || "";
        let parsed: any = bodyText;
        try {
          parsed = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          parsed = bodyText;
        }

        const ok = response.statusCode < 400;
        jsonReply(ws, {
          id,
          ok,
          statusCode: response.statusCode,
          data: ok ? parsed : undefined,
          error: ok ? undefined : parsed?.error || parsed || "Request failed",
        });
      } catch (error: any) {
        jsonReply(ws, {
          id,
          ok: false,
          statusCode: 500,
          error: error?.message || "Internal WS relay error",
        });
      }
    });
  }
}
