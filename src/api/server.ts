import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/types.js';
import { makeAuthHook } from './auth.js';
import { ApiError, codeForStatus, errorEnvelope } from './errors.js';
import { API_VERSION, APP_NAME, VERSION } from '../version.js';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', makeAuthHook(config.api.token ?? ''));

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send(errorEnvelope('not_found', 'no such route'));
  });

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof ApiError) {
      await reply.code(error.statusCode).send(errorEnvelope(error.code, error.message));
      return;
    }
    const fastifyError = error as { statusCode?: unknown; message?: unknown };
    const statusCode =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
        ? fastifyError.statusCode
        : 500;
    const message = statusCode >= 500 ? 'internal error' : String(fastifyError.message ?? 'error');
    if (statusCode >= 500) console.error(error);
    await reply.code(statusCode).send(errorEnvelope(codeForStatus(statusCode), message));
  });

  app.register(
    async (v1) => {
      v1.get('/health', { config: { public: true } }, async () => ({
        app: APP_NAME,
        version: VERSION,
        apiVersion: API_VERSION,
      }));
    },
    { prefix: '/v1' },
  );

  return app;
}

export async function startServer(app: FastifyInstance, config: Config): Promise<string> {
  return app.listen({ port: config.api.port, host: config.api.bind });
}
