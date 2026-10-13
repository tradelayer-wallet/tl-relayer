// src/routes/attestation.route.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isIP } from 'net';
import { envConfig } from '../config/env.config';
import { AttestationService } from '../services/attestation.service';
import { isTrustedProxyPeer, resolveClientIp } from '../services/security-utils.service';

const attestationService = new AttestationService();

type AttestationIpBody = {
  ip?: string;
};

// Issue #1 / H3 + round 2 / NEW-2: forwarding headers are believed only when
// TRUST_PROXY=1 and the TCP peer is one of TRUST_PROXY_CIDRS (validated at
// startup). Everything in this route that depends on the caller's IP goes
// through resolveClientIp with this list.
const trustedProxies = (): string[] => (envConfig.TRUST_PROXY ? envConfig.TRUST_PROXY_CIDRS : []);

// Issue #1 round 2 / NEW-5: the public /attestation/* routes fan out to several
// outbound reputation providers per request. Bound both the per-client request
// rate (fixed window, keyed on the resolved client IP) and the global number of
// lookups in flight.
const RATE_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_CLIENTS = 4096;

type RateWindow = { count: number; windowStart: number };
const rateWindows = new Map<string, RateWindow>();
let inFlight = 0;

function consumeRateToken(clientKey: string): boolean {
  const now = Date.now();
  let win = rateWindows.get(clientKey);
  if (!win || now - win.windowStart >= RATE_WINDOW_MS) {
    // Keep the table bounded: when full, evict the oldest-inserted client.
    if (!win && rateWindows.size >= MAX_TRACKED_CLIENTS) {
      const oldest = rateWindows.keys().next();
      if (!oldest.done) rateWindows.delete(oldest.value);
    }
    win = { count: 0, windowStart: now };
    rateWindows.set(clientKey, win);
  }
  if (win.count >= envConfig.ATTESTATION_RATE_LIMIT_PER_MIN) return false;
  win.count += 1;
  return true;
}

export async function registerAttestationRoutes(server: FastifyInstance) {
  const lookupIpReputation = async (ipInput: string, reply: FastifyReply) => {
    if (!ipInput) {
      reply.code(400);
      return {
        success: false,
        error: 'Unable to determine client IP',
      };
    }

    // Issue #1 / H3: never interpolate an unvalidated string into outbound URLs.
    const normalizedIp = ipInput.trim().replace(/^::ffff:/, '');
    if (!isIP(normalizedIp)) {
      reply.code(400);
      return {
        success: false,
        error: 'Invalid client IP',
      };
    }

    try {
      const result = await attestationService.checkIp(normalizedIp);
      return result;
    } catch (err: any) {
      console.error(
        { err },
        '[attestation] Failed to check IP reputation',
      );
      reply.code(500);
      return {
        success: false,
        ip: normalizedIp,
        error: 'Internal error while checking IP reputation',
      };
    }
  };

  const handleIpCheck = async (
    req: FastifyRequest<{ Body?: AttestationIpBody }>,
    reply: FastifyReply,
  ) => {
    // Quota and concurrency gates run before any body parsing or outbound work.
    // The client identity is always the resolved client IP, never the body value,
    // so a request cannot choose its own rate-limit bucket.
    const peer = String((req.socket && req.socket.remoteAddress) || '');
    const trusted = trustedProxies();
    const clientIp = resolveClientIp(peer, req.headers, trusted);
    if (!consumeRateToken(clientIp || 'unknown')) {
      reply.code(429).header('retry-after', '60');
      return {
        success: false,
        error: 'Rate limit exceeded for IP reputation lookups',
      };
    }
    if (inFlight >= envConfig.ATTESTATION_MAX_IN_FLIGHT) {
      reply.code(503).header('retry-after', '1');
      return {
        success: false,
        error: 'Too many IP reputation lookups in flight; retry shortly',
      };
    }

    inFlight += 1;
    try {
      // Issue #1 / H3: the body IP override is honored only when the operator
      // enables it AND the direct peer is a trusted proxy forwarding an end-user
      // address (issue #1 round 2 / NEW-2).
      const bodyIp = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
      const overrideAllowed =
        envConfig.ATTESTATION_ALLOW_IP_OVERRIDE && isTrustedProxyPeer(peer, trusted);
      return await lookupIpReputation(overrideAllowed && bodyIp ? bodyIp : clientIp, reply);
    } finally {
      inFlight -= 1;
    }
  };

  server.get('/ip', handleIpCheck);
  server.post('/ip', handleIpCheck);
  server.post('/check', handleIpCheck);
}
