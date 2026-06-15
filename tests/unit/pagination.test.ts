// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.js';
import { parseFields, parseListQuery, requireObjectBody } from '../../src/api/pagination.js';

const MODEL_FIELDS = ['id', 'parent_id', 'title', 'body', 'updated_time', 'created_time'];

function parse(query: Record<string, unknown>, allowParentFilter = false) {
  return parseListQuery(query, { modelFields: MODEL_FIELDS, allowParentFilter });
}

describe('parseListQuery', () => {
  it('applies defaults', () => {
    const p = parse({});
    expect(p).toMatchObject({
      page: 1,
      limit: 100,
      orderBy: 'updated_time',
      orderDir: 'DESC',
      includeDeleted: false,
    });
    expect(p.fields).toEqual(['id', 'parent_id', 'title', 'updated_time']);
  });

  it('parses explicit values', () => {
    const p = parse({
      page: '3',
      limit: '2',
      order_by: 'created_time',
      order_dir: 'asc',
      fields: 'id,body',
      include_deleted: 'true',
    });
    expect(p).toMatchObject({ page: 3, limit: 2, orderBy: 'created_time', orderDir: 'ASC', includeDeleted: true });
    expect(p.fields).toEqual(['id', 'body']);
  });

  it('rejects bad pages, limits, order fields and dirs', () => {
    expect(() => parse({ page: '0' })).toThrow(ApiError);
    expect(() => parse({ page: 'x' })).toThrow(ApiError);
    expect(() => parse({ limit: '1001' })).toThrow(/maximum/);
    expect(() => parse({ order_by: 'evil; DROP TABLE notes' })).toThrow(ApiError);
    expect(() => parse({ order_dir: 'sideways' })).toThrow(ApiError);
    expect(() => parse({ fields: 'id,nope' })).toThrow(/unknown field/);
  });

  it('handles parent_id only when allowed and well-formed', () => {
    const id = 'a'.repeat(32);
    expect(parse({ parent_id: id }, true).parentId).toBe(id);
    expect(parse({ parent_id: '' }, true).parentId).toBe('');
    expect(() => parse({ parent_id: 'zz' }, true)).toThrow(ApiError);
    expect(parse({ parent_id: id }, false).parentId).toBeUndefined();
  });
});

describe('parseFields', () => {
  it('dedupes and validates', () => {
    expect(parseFields({ fields: 'id, title ,id' }, MODEL_FIELDS)).toEqual(['id', 'title']);
    expect(() => parseFields({ fields: '' }, MODEL_FIELDS)).toThrow(ApiError);
  });
});

describe('requireObjectBody', () => {
  it('accepts objects, rejects everything else', () => {
    expect(requireObjectBody({ a: 1 })).toEqual({ a: 1 });
    expect(() => requireObjectBody(null)).toThrow(ApiError);
    expect(() => requireObjectBody([1])).toThrow(ApiError);
    expect(() => requireObjectBody('x')).toThrow(ApiError);
  });
});
