// src/routes/attestation.route.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isIP } from 'net';
import { AttestationService } from '../services/attestation.service';

const attestationService = new AttestationService();

type AttestationIpBody = {
  ip?: string;
};

const trustProxyHeaders = (): boolean =>
  String(process.env.TRUST_PROXY || '').trim() === '1';

function extractClientIp(req: FastifyRequest): string {
  // Issue #1 / H3: forwarding headers are only trusted when the operator has
  // explicitly configured a trusted proxy via TRUST_PROXY=1. Otherwise the
  // socket address is used, so clients cannot spoof their IP with one header.
  if (trustProxyHeaders()) {
    const headers = req.headers;

    // Cloudflare first
    const cfIp = headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.length > 0) return cfIp;

    // Nginx real_ip / forwarded_for chain
    const xRealIp = headers['x-real-ip'];
    if (typeof xRealIp === 'string' && xRealIp.length > 0) return xRealIp;

    const xff = headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return String(xff[0]).split(',')[0].trim();
    }
  }

  // Socket address (or Fastify's proxy-derived IP when proxy handling is configured)
  return req.ip;
}

export async function registerAttestationRoutes(server: FastifyInstance) {
  const handleIpCheck = async (
    req: FastifyRequest<{ Body?: AttestationIpBody }>,
    reply: FastifyReply,
  ) => {
    const bodyIp = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
    // Issue #1 / H3: the body IP override is hard-disabled unless the operator
    // explicitly trusts its proxy chain (TRUST_PROXY=1) AND opts in here.
    const allowIpOverride =
      process.env.ATTESTATION_ALLOW_IP_OVERRIDE === '1' && trustProxyHeaders();
    const ip = allowIpOverride && bodyIp ? bodyIp : extractClientIp(req);

    if (!ip) {
      reply.code(400);
      return {
        success: false,
        error: 'Unable to determine client IP',
      };
    }

    // Issue #1 / H3: never interpolate an unvalidated string into outbound URLs.
    const normalizedIp = ip.trim().replace(/^::ffff:/, '');
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

  server.get('/ip', handleIpCheck);
  server.post('/ip', handleIpCheck);
  server.post('/check', handleIpCheck);
}
