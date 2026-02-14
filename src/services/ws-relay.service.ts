import { FastifyInstance } from "fastify";
import { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";

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

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, url.pathname);
      });
    });
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

      const id = payload.id;
      try {
        const method = (payload.method || (payload.body ? "POST" : "GET")).toUpperCase();
        const targetPath = normalizePath(payload.path || boundPath);
        const targetUrl = withQuery(targetPath, payload.query);

        const response: any = await (this.app as any).inject({
          method,
          url: targetUrl,
          payload: payload.body,
          headers: {
            "content-type": "application/json",
            ...(payload.headers || {}),
          },
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
