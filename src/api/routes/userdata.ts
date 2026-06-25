// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from 'fastify';
import type { JoplinContext } from '../../joplin/bootstrap.js';
import { deleteKey, getKey, getNamespace, putKey, type UserDataKind } from '../../joplin/userdata.js';
import { ApiError } from '../errors.js';
import { requireObjectBody } from '../pagination.js';

const KIND_BY_PLURAL: Record<string, UserDataKind> = {
  notes: 'note',
  notebooks: 'notebook',
  tags: 'tag',
  resources: 'resource',
};

type Params = { id: string; ns: string; key: string };

export function registerUserDataRoutes(v1: FastifyInstance, ctx: JoplinContext): void {
  for (const [plural, kind] of Object.entries(KIND_BY_PLURAL)) {
    v1.get(`/${plural}/:id/userdata/:ns`, async (request) => {
      const { id, ns } = request.params as Params;
      return getNamespace(ctx, kind, id, ns);
    });

    v1.get(`/${plural}/:id/userdata/:ns/:key`, async (request) => {
      const { id, ns, key } = request.params as Params;
      return getKey(ctx, kind, id, ns, key);
    });

    v1.put(`/${plural}/:id/userdata/:ns/:key`, async (request) => {
      const { id, ns, key } = request.params as Params;
      const body = requireObjectBody(request.body);
      if (!('value' in body)) {
        throw new ApiError(400, 'bad_request', 'body must be {"value": <json value>}');
      }
      return putKey(ctx, kind, id, ns, key, body.value);
    });

    v1.delete(`/${plural}/:id/userdata/:ns/:key`, async (request, reply) => {
      const { id, ns, key } = request.params as Params;
      await deleteKey(ctx, kind, id, ns, key);
      return reply.code(204).send();
    });
  }
}
