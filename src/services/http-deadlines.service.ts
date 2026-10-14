import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { Socket } from 'net';

/**
 * Per-connection request deadlines (round 8, slowloris).
 *
 * Node's own `headersTimeout` and `requestTimeout` do not close stalled connections on the
 * runtime this relayer targets (Node 24.20): with a partial header block, the connections
 * expiry check kept returning zero and the socket stayed open for 150 s with the default
 * 60 s `headersTimeout`. Socket-level inactivity (`server.timeout`) works but is defeated by a
 * slow drip, so a sender can hold a socket for as long as it keeps trickling bytes. This
 * watchdog is the single enforcement point for the request phase:
 *
 * - a new connection must deliver its request headers within HEADERS_DEADLINE_MS;
 * - once the headers are in, an unfinished body must arrive within BODY_DEADLINE_MS;
 * - after a response finishes, an idle keep-alive socket is closed after KEEP_ALIVE_IDLE_MS;
 * - an upgraded socket (WebSocket relay) leaves HTTP tracking, so no deadline applies to it.
 *
 * Handler time is not covered here; route handlers bound their own outbound calls.
 */
export const HEADERS_DEADLINE_MS = 10_000;
export const BODY_DEADLINE_MS = 30_000;
export const KEEP_ALIVE_IDLE_MS = 60_000;

const timers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();

const clearDeadline = (socket: Socket): void => {
  const timer = timers.get(socket);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(socket);
  }
};

const armDeadline = (socket: Socket, ms: number): void => {
  clearDeadline(socket);
  const timer = setTimeout(() => {
    timers.delete(socket);
    socket.destroy();
  }, ms);
  timers.set(socket, timer);
};

export const attachRequestDeadlines = (server: Server): void => {
  server.on('connection', (socket: Socket) => {
    armDeadline(socket, HEADERS_DEADLINE_MS);
    socket.once('close', () => clearDeadline(socket));
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const socket = req.socket;
    clearDeadline(socket);
    if (!req.complete) {
      armDeadline(socket, BODY_DEADLINE_MS);
      req.once('end', () => clearDeadline(socket));
    }
    res.once('finish', () => {
      if (!socket.destroyed) armDeadline(socket, KEEP_ALIVE_IDLE_MS);
    });
  });

  // The WebSocket relay owns upgraded sockets. Their idle and lifetime rules are not HTTP ones.
  server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
    clearDeadline(socket);
  });
};
