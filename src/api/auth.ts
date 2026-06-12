import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope } from './errors.js';

// Compare via fixed-length digests so the comparison is constant-time even
// for attacker-chosen lengths.
export function tokensEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  // ?token= is accepted everywhere and required for SSE (EventSource cannot
  // set headers).
  const query = request.query as Record<string, unknown> | null;
  const token = query?.token;
  if (typeof token === 'string' && token !== '') return token;
  return null;
}

// Global onRequest hook. Routes opt out of auth by declaring
// `config: { public: true }` (only GET /health does).
export function makeAuthHook(expectedToken: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const routeConfig = request.routeOptions?.config as { public?: boolean } | undefined;
    if (routeConfig?.public === true) return;

    const presented = presentedToken(request);
    if (presented !== null && tokensEqual(presented, expectedToken)) return;

    await reply
      .code(401)
      .send(errorEnvelope('unauthorized', 'missing or invalid API token'));
  };
}
