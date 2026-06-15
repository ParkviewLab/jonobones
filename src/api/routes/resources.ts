// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { JoplinContext } from '../../joplin/bootstrap.js';
import {
  createResourceFromFile,
  deleteResource,
  getResource,
  listResources,
  resourceBlob,
  resourceFieldNames,
  resourcesOfNote,
  updateResource,
} from '../../joplin/resources.js';
import { ApiError } from '../errors.js';
import { parseFields, parseListQuery, requireObjectBody } from '../pagination.js';

type Params = { id: string };
type Query = Record<string, unknown>;

export function registerResourceRoutes(v1: FastifyInstance, ctx: JoplinContext): void {
  v1.get('/resources', async (request) => {
    const params = parseListQuery(request.query as Query, { modelFields: resourceFieldNames(ctx) });
    return listResources(ctx, params);
  });

  // Multipart: a `data` file part (the blob) and an optional `props` field
  // (JSON: {id?, title?}).
  v1.post('/resources', async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ApiError(400, 'bad_request', 'POST /resources expects multipart/form-data with a "data" file part');
    }

    const stagingDir = await mkdtemp(join(tmpdir(), 'jonobones-upload-'));
    try {
      let dataPath: string | null = null;
      let originalFilename: string | null = null;
      let props: Record<string, unknown> = {};

      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'data') {
          originalFilename = part.filename || 'untitled';
          dataPath = join(stagingDir, originalFilename.replaceAll('/', '_') || 'blob');
          await pipeline(part.file, createWriteStream(dataPath));
        } else if (part.type === 'field' && part.fieldname === 'props') {
          try {
            props = requireObjectBody(JSON.parse(String(part.value)));
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, 'bad_request', `props is not valid JSON: ${(error as Error).message}`);
          }
        }
      }

      if (!dataPath) throw new ApiError(400, 'bad_request', 'missing "data" file part');

      const resource = await createResourceFromFile(ctx, dataPath, props);
      return await reply.code(201).send(resource);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  v1.get('/resources/:id', async (request) => {
    const { id } = request.params as Params;
    const fields = parseFields(request.query as Query, resourceFieldNames(ctx));
    return getResource(ctx, id, fields);
  });

  v1.get('/resources/:id/file', async (request, reply) => {
    const { id } = request.params as Params;
    const blob = await resourceBlob(ctx, id);
    reply.header('content-type', blob.mime);
    reply.header('content-length', blob.size);
    reply.header('content-disposition', `attachment; filename="${blob.filename.replaceAll('"', '')}"`);
    return reply.send(createReadStream(blob.path));
  });

  v1.patch('/resources/:id', async (request) => {
    const { id } = request.params as Params;
    const body = requireObjectBody(request.body);
    return updateResource(ctx, id, body);
  });

  v1.delete('/resources/:id', async (request, reply) => {
    const { id } = request.params as Params;
    await deleteResource(ctx, id);
    return reply.code(204).send();
  });

  v1.get('/notes/:id/resources', async (request) => {
    const { id } = request.params as Params;
    const fields = parseFields(request.query as Query, resourceFieldNames(ctx));
    return resourcesOfNote(ctx, id, fields);
  });
}
