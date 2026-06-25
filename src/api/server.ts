// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { Config } from '../config/types.js';
import type { JoplinContext } from '../joplin/bootstrap.js';
import { ItemConflictError, ItemNotFoundError, ItemValidationError } from '../joplin/errors.js';
import { makeAuthHook } from './auth.js';
import { ApiError, codeForStatus, errorEnvelope } from './errors.js';
import { registerItemRoutes } from './routes/items.js';
import { registerUserDataRoutes } from './routes/userdata.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerExtraRoutes } from './routes/extras.js';
import { registerServiceRoutes, type ServiceDeps } from './routes/service.js';
import { registerEventRoutes } from './routes/events.js';
import type { EventHub } from '../events/hub.js';
import { API_VERSION, APP_NAME, VERSION } from '../version.js';

export function buildServer(
  config: Config,
  joplin: JoplinContext | null = null,
  service: ServiceDeps | null = null,
  hub: EventHub | null = null,
): FastifyInstance {
  // maxParamLength: userdata namespace/key segments are up to 255 chars
  // (Joplin's limit); Fastify's default of 100 would 404 them.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 512 } });

  // 512 MB blob ceiling; resources of that size already strain Joplin sync.
  app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', makeAuthHook(config.api.token ?? ''));

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send(errorEnvelope('not_found', 'no such route'));
  });

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    if (error instanceof ApiError) {
      await reply.code(error.statusCode).send(errorEnvelope(error.code, error.message));
      return;
    }
    if (error instanceof ItemNotFoundError) {
      await reply.code(404).send(errorEnvelope('not_found', error.message));
      return;
    }
    if (error instanceof ItemValidationError) {
      await reply.code(400).send(errorEnvelope('bad_request', error.message));
      return;
    }
    if (error instanceof ItemConflictError) {
      await reply.code(409).send(errorEnvelope('conflict', error.message));
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

      if (joplin) {
        registerItemRoutes(v1, joplin);
        registerUserDataRoutes(v1, joplin);
        registerResourceRoutes(v1, joplin);
        registerExtraRoutes(v1, joplin);
        if (service) registerServiceRoutes(v1, joplin, service);
        if (hub) registerEventRoutes(v1, hub);
      }
    },
    { prefix: '/v1' },
  );

  return app;
}

export async function startServer(app: FastifyInstance, config: Config): Promise<string> {
  return app.listen({ port: config.api.port, host: config.api.bind });
}
