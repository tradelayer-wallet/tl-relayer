import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { Socket } from 'net';

/**
 * Per-connection request deadlines (round 8, slowloris; corrected in round 10).
 *
 * Node's own `headersTimeout` and `requestTimeout` do not close stalled connections on the
 * runtime this relayer targets (Node 24.20): with a partial header block, the connections
 * expiry check kept returning zero and the socket stayed open for 150 s with the default
 * 60 s `headersTimeout`. Socket-level inactivity (`server.timeout`) works but is defeated by a
 * slow drip, so a sender can hold a socket for as long as it keeps trickling bytes. This
 * watchdog is the single enforcement point for the request phase:
 *
 * - a new connection must deliver its request headers within HEADERS_DEADLINE_MS;
 * - once the headers of a request that carries a body are in, the body must be complete within
 *   BODY_DEADLINE_MS. A request without a body (GET, HEAD, DELETE with no Content-Length) has no
 *   body phase: Node does not emit 'end' for a body nobody reads until the response finishes, so
 *   arming a body deadline on it would close the socket during a slow but honest handler;
 * - when no request is in flight after a response finishes, the idle keep-alive socket is closed
 *   after KEEP_ALIVE_IDLE_MS (a later request, or a pipelined one, clears the timer first);
 * - an upgraded socket (WebSocket relay) leaves HTTP tracking, so no deadline applies to it.
 *
 * One timer per socket: a request clears the timer that guards the previous phase, and only the
 * timer a request armed is cleared by that request's own events. Handler time is not covered here;
 * route handlers bound their own outbound calls.
 */
export const HEADERS_DEADLINE_MS = 10_000;
export const BODY_DEADLINE_MS = 30_000;
export const KEEP_ALIVE_IDLE_MS = 60_000;

export interface RequestDeadlines {
  headersMs: number;
  bodyMs: number;
  idleMs: number;
}

export const DEFAULT_REQUEST_DEADLINES: RequestDeadlines = {
  headersMs: HEADERS_DEADLINE_MS,
  bodyMs: BODY_DEADLINE_MS,
  idleMs: KEEP_ALIVE_IDLE_MS,
};

type Timer = ReturnType<typeof setTimeout>;
type SocketState = { timer: Timer | null; inFlight: number };

const states = new WeakMap<Socket, SocketState>();

const stateOf = (socket: Socket): SocketState => {
  let state = states.get(socket);
  if (!state) {
    state = { timer: null, inFlight: 0 };
    states.set(socket, state);
  }
  return state;
};

const clearTimer = (state: SocketState): void => {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
};

// Replaces the socket's deadline and returns the new timer, so the owner can clear it later.
const armTimer = (socket: Socket, state: SocketState, ms: number): Timer => {
  clearTimer(state);
  const timer: Timer = setTimeout(() => {
    if (state.timer === timer) state.timer = null;
    socket.destroy();
  }, ms);
  state.timer = timer;
  return timer;
};

const declaresBody = (req: IncomingMessage): boolean =>
  req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

export const attachRequestDeadlines = (
  server: Server,
  deadlines: RequestDeadlines = DEFAULT_REQUEST_DEADLINES,
): void => {
  server.on('connection', (socket: Socket) => {
    const state = stateOf(socket);
    armTimer(socket, state, deadlines.headersMs);
    socket.once('close', () => clearTimer(state));
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const socket = req.socket;
    const state = stateOf(socket);
    clearTimer(state);
    state.inFlight += 1;
    if (!req.complete && declaresBody(req)) {
      const bodyTimer = armTimer(socket, state, deadlines.bodyMs);
      req.once('end', () => {
        if (state.timer === bodyTimer) clearTimer(state);
      });
    }
    res.once('finish', () => {
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (state.inFlight === 0 && !socket.destroyed) armTimer(socket, state, deadlines.idleMs);
    });
  });

  // The WebSocket relay owns upgraded sockets. Their idle and lifetime rules are not HTTP ones.
  server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
    clearTimer(stateOf(socket));
  });
};
