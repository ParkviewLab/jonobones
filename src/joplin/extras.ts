// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JoplinContext } from './bootstrap.js';
import type { JoplinItem, ListParams, ListResult } from './items.js';

function projectFields(item: JoplinItem, fields: string[]): JoplinItem {
  const out: JoplinItem = {};
  for (const field of fields) {
    if (field in item) out[field] = item[field];
  }
  return out;
}

/**
 * Full-text search via lib's SearchEngine. syncTables() first folds pending
 * item_changes into the FTS index, so results reflect every API write.
 * Results keep the engine's relevance order; has_more is always false
 * (relevance-ranked results are not stably pageable).
 */
export async function searchNotes(
  ctx: JoplinContext,
  query: string,
  { limit, fields }: { limit: number; fields: string[] },
): Promise<ListResult> {
  const engine = ctx.lib.SearchEngine.instance();
  await engine.syncTables();
  const rows = (await engine.search(query)) as { id: string }[];

  const ids = rows.slice(0, limit).map((r) => r.id);
  if (!ids.length) return { items: [], has_more: false };

  const placeholders = ids.map(() => '?').join(', ');
  const found = (await ctx.lib.Note.modelSelectAll(
    `SELECT ${fields.join(', ')}${fields.includes('id') ? '' : ', id'} FROM notes WHERE id IN (${placeholders})`,
    ids,
  )) as JoplinItem[];

  const byId = new Map(found.map((item) => [item.id as string, item]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((item): item is JoplinItem => item !== undefined)
    .map((item) => projectFields(item, fields));
  return { items, has_more: rows.length > limit };
}

export function revisionFieldNames(ctx: JoplinContext): string[] {
  return ctx.lib.Revision.fieldNames() as string[];
}

/**
 * Read-only view of the revisions table. Note: revisions accumulate only
 * while the revision service runs (wired up with the sync scheduler);
 * this endpoint just exposes what exists.
 */
export async function listRevisions(ctx: JoplinContext, params: ListParams): Promise<ListResult> {
  const offset = (params.page - 1) * params.limit;
  const sql =
    `SELECT ${params.fields.join(', ')} FROM revisions ` +
    `ORDER BY ${params.orderBy} ${params.orderDir}, id ${params.orderDir} ` +
    `LIMIT ${params.limit + 1} OFFSET ${offset}`;
  const rows = (await ctx.lib.Revision.modelSelectAll(sql, [])) as JoplinItem[];
  return {
    items: rows.slice(0, params.limit).map((row) => projectFields(row, params.fields)),
    has_more: rows.length > params.limit,
  };
}

/** Conflict notes (is_conflict = 1), §5.8. */
export async function listConflicts(ctx: JoplinContext, params: ListParams): Promise<ListResult> {
  const offset = (params.page - 1) * params.limit;
  const sql =
    `SELECT ${params.fields.join(', ')} FROM notes WHERE is_conflict = 1 ` +
    `ORDER BY ${params.orderBy} ${params.orderDir}, id ${params.orderDir} ` +
    `LIMIT ${params.limit + 1} OFFSET ${offset}`;
  const rows = (await ctx.lib.Note.modelSelectAll(sql, [])) as JoplinItem[];
  return {
    items: rows.slice(0, params.limit).map((row) => projectFields(row, params.fields)),
    has_more: rows.length > params.limit,
  };
}
