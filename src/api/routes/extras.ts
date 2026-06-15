// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from 'fastify';
import type { JoplinContext } from '../../joplin/bootstrap.js';
import { listConflicts, listRevisions, revisionFieldNames, searchNotes } from '../../joplin/extras.js';
import { fieldNamesFor } from '../../joplin/items.js';
import { ApiError } from '../errors.js';
import { DEFAULT_LIMIT, MAX_LIMIT, parseFields, parseListQuery } from '../pagination.js';

type Query = Record<string, unknown>;

export function registerExtraRoutes(v1: FastifyInstance, ctx: JoplinContext): void {
  v1.get('/search', async (request) => {
    const query = request.query as Query;
    const q = query.q;
    if (typeof q !== 'string' || q.trim() === '') {
      throw new ApiError(400, 'bad_request', 'q is required');
    }
    const rawLimit = query.limit;
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
        throw new ApiError(400, 'bad_request', 'limit must be a positive integer');
      }
      limit = parseInt(rawLimit, 10);
      if (limit < 1 || limit > MAX_LIMIT) {
        throw new ApiError(400, 'bad_request', `limit must be 1-${MAX_LIMIT}`);
      }
    }
    const fields = parseFields(query, fieldNamesFor(ctx, 'note'));
    return searchNotes(ctx, q, { limit, fields });
  });

  v1.get('/revisions', async (request) => {
    const params = parseListQuery(request.query as Query, { modelFields: revisionFieldNames(ctx) });
    return listRevisions(ctx, params);
  });

  v1.get('/conflicts', async (request) => {
    const query = request.query as Query;
    const noteFields = fieldNamesFor(ctx, 'note');
    const params = parseListQuery(query, { modelFields: noteFields });
    // §5.8: conflicts include conflict_original_id unless the caller picked
    // their own field set.
    if (query.fields === undefined && !params.fields.includes('conflict_original_id')) {
      params.fields.push('conflict_original_id');
    }
    return listConflicts(ctx, params);
  });
}
