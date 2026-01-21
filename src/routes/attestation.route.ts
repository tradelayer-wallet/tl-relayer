// src/routes/attestation.route.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AttestationService } from '../services/attestation.service';

const attestationService = new AttestationService();

function extractClientIp(req: FastifyRequest): string {
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

  // Fallback: Fastify's notion of IP (may be proxy if real_ip not configured)
  return req.ip;
}

export async function registerAttestationRoutes(server: FastifyInstance) {
  server.get('/ip', async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = extractClientIp(req);

    if (!ip) {
      reply.code(400);
      return {
        success: false,
        error: 'Unable to determine client IP',
      };
    }

    try {
      const result = await attestationService.checkIp(ip);
      return result;
    } catch (err: any) {
      console.error(
        { err },
        '[attestation] Failed to check IP reputation',
      );
      reply.code(500);
      return {
        success: false,
        ip,
        error: 'Internal error while checking IP reputation',
      };
    }
  });
}
