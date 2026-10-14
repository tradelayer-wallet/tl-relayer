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

// Round 8: largest WebSocket frame accepted. The ws default is 100 MiB, and a frame is buffered
// whole before the relay sees it, so one connection could hold 100 MiB per message. 1 MiB matches
// the HTTP body limit (Fastify's default bodyLimit), so both surfaces accept the same request size.
// A larger frame closes the connection with 1009 before it is parsed.
const WS_RELAY_MAX_PAYLOAD_BYTES = 1024 * 1024;

// Methods the relayed routes use. Anything else is refused before app.inject (round 7 / F-B3).
const WS_RELAY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

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
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_RELAY_MAX_PAYLOAD_BYTES });
    this.attachUpgradeHandler();
  }

  private attachUpgradeHandler() {
    this.app.server.on("upgrade", (req, socket, head) => {
      const url = this.safeParseUrl(req);
      if (!url || !(url.pathname === "/ws" || url.pathname.startsWith("/ws/"))) {
        // Round 7 / F-B4: once an 'upgrade' listener exists Node no longer destroys
        // unclaimed upgrade sockets, so an unauthenticated Upgrade to any other path
        // (or with an unparseable target) would stay open with no timeout.
        socket.destroy();
        return;
      }

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
      // Round 7 / F-B3: the method reaches app.inject, and light-my-request throws for a
      // method outside its own allowlist from a deferred tick, which no try/catch here can
      // catch. Any unknown method token (`\u0000`, `G ET`, a 100-char string) used to exit
      // the whole relayer. Refuse everything outside the methods the routes use.
      const requestedMethod = payload.method || (payload.body ? "POST" : "GET");
      const method = typeof requestedMethod === "string" ? requestedMethod.toUpperCase() : "";
      if (!WS_RELAY_METHODS.has(method)) {
        jsonReply(ws, { id, ok: false, statusCode: 400, error: "Unsupported method" });
        return;
      }
      try {
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
