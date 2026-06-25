// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ListParams } from '../joplin/items.js';
import { ID_PATTERN } from '../joplin/items.js';
import { ApiError } from './errors.js';

export const DEFAULT_FIELDS = ['id', 'parent_id', 'title', 'updated_time'];
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

type Query = Record<string, unknown>;

function bad(message: string): never {
  throw new ApiError(400, 'bad_request', message);
}

function parsePositiveInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) bad(`${name} must be a positive integer`);
  const value = parseInt(raw, 10);
  if (value < 1) bad(`${name} must be >= 1`);
  return value;
}

export function parseFields(query: Query, modelFields: string[]): string[] {
  const raw = query.fields;
  if (raw === undefined) {
    return DEFAULT_FIELDS.filter((f) => modelFields.includes(f));
  }
  if (typeof raw !== 'string' || raw.trim() === '') bad('fields must be a comma-separated list');
  const fields = raw.split(',').map((f) => f.trim()).filter((f) => f !== '');
  if (!fields.length) bad('fields must name at least one field');
  for (const field of fields) {
    if (!modelFields.includes(field)) bad(`unknown field: ${JSON.stringify(field)}`);
  }
  return [...new Set(fields)];
}

export interface ParseListOptions {
  modelFields: string[];
  allowParentFilter?: boolean;
}

export function parseListQuery(query: Query, { modelFields, allowParentFilter = false }: ParseListOptions): ListParams {
  const page = parsePositiveInt(query.page, 'page', 1);
  const limit = parsePositiveInt(query.limit, 'limit', DEFAULT_LIMIT);
  if (limit > MAX_LIMIT) bad(`limit exceeds the maximum of ${MAX_LIMIT}`);

  const orderBy = typeof query.order_by === 'string' && query.order_by !== '' ? query.order_by : 'updated_time';
  if (!modelFields.includes(orderBy)) bad(`cannot order by unknown field ${JSON.stringify(orderBy)}`);

  let orderDir: 'ASC' | 'DESC' = 'DESC';
  if (query.order_dir !== undefined) {
    const raw = String(query.order_dir).toUpperCase();
    if (raw !== 'ASC' && raw !== 'DESC') bad('order_dir must be "asc" or "desc"');
    orderDir = raw;
  }

  const params: ListParams = {
    page,
    limit,
    orderBy,
    orderDir,
    fields: parseFields(query, modelFields),
    includeDeleted: query.include_deleted === 'true' || query.include_deleted === '1',
  };

  if (allowParentFilter && query.parent_id !== undefined) {
    const parentId = query.parent_id;
    if (typeof parentId !== 'string') bad('parent_id must be a string');
    if (parentId !== '' && !ID_PATTERN.test(parentId)) bad('parent_id must be a 32-character hex id');
    params.parentId = parentId;
  }

  return params;
}

export function parseBooleanFlag(query: Query, name: string): boolean {
  const raw = query[name];
  return raw === 'true' || raw === '1';
}

export function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    bad('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}
