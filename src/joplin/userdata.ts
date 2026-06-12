// Envelope-safe user_data operations (§5.7). Joplin's user_data column is
// a per-key LWW-merged envelope: { ns: { key: { v, t, d? } } }. Writing raw
// JSON would silently break conflict merging, so every write goes through
// lib's setItemUserData/deleteItemUserData — which also bump updated_time
// so the change syncs. Deletion is a tombstone (d:1), not removal.

import type { JoplinContext } from './bootstrap.js';
import { ItemNotFoundError, ItemValidationError } from './errors.js';
import { ID_PATTERN } from './items.js';

export type UserDataKind = 'note' | 'notebook' | 'tag' | 'resource';

const MAX_KEY_LENGTH = 255; // upstream constant (their own length check is broken — missing throw)

interface EnvelopeValue {
  v: unknown;
  t: number;
  d?: number;
}

type Envelope = Record<string, Record<string, EnvelopeValue>>;

/* eslint-disable @typescript-eslint/no-explicit-any -- lib boundary */
function modelTypeFor(ctx: JoplinContext, kind: UserDataKind): any {
  const { ModelType } = ctx.lib;
  if (kind === 'note') return ModelType.Note;
  if (kind === 'notebook') return ModelType.Folder;
  if (kind === 'tag') return ModelType.Tag;
  return ModelType.Resource;
}

function modelFor(ctx: JoplinContext, kind: UserDataKind): any {
  if (kind === 'note') return ctx.lib.Note;
  if (kind === 'notebook') return ctx.lib.Folder;
  if (kind === 'tag') return ctx.lib.Tag;
  return ctx.lib.Resource;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function loadEnvelope(ctx: JoplinContext, kind: UserDataKind, id: string): Promise<Envelope> {
  if (!ID_PATTERN.test(id)) throw new ItemNotFoundError(kind, id);
  const item = (await modelFor(ctx, kind).load(id, { fields: ['id', 'user_data'] })) as
    | { user_data?: string }
    | null;
  if (!item) throw new ItemNotFoundError(kind, id);
  const raw = item.user_data;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Envelope;
  } catch (error) {
    throw new Error(`corrupt user_data on ${kind} ${id}: ${(error as Error).message}`, { cause: error });
  }
}

function validateNamespaceAndKey(ns: string, key?: string): void {
  if (ns === '' || ns.length > MAX_KEY_LENGTH) {
    throw new ItemValidationError(`namespace must be 1-${MAX_KEY_LENGTH} characters`);
  }
  if (key !== undefined && (key === '' || key.length > MAX_KEY_LENGTH)) {
    throw new ItemValidationError(`key must be 1-${MAX_KEY_LENGTH} characters`);
  }
}

/** All live (non-tombstoned) keys in a namespace, as a plain key→value map. */
export async function getNamespace(
  ctx: JoplinContext,
  kind: UserDataKind,
  id: string,
  ns: string,
): Promise<Record<string, unknown>> {
  validateNamespaceAndKey(ns);
  const envelope = await loadEnvelope(ctx, kind, id);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(envelope[ns] ?? {})) {
    if (!entry.d) out[key] = entry.v;
  }
  return out;
}

export async function getKey(
  ctx: JoplinContext,
  kind: UserDataKind,
  id: string,
  ns: string,
  key: string,
): Promise<{ value: unknown }> {
  validateNamespaceAndKey(ns, key);
  await loadEnvelope(ctx, kind, id); // 404 on missing item
  const value = await ctx.lib.getItemUserData(modelTypeFor(ctx, kind), id, ns, key);
  if (value === undefined) throw new ItemNotFoundError(`${kind} userdata key`, `${ns}/${key}`);
  return { value };
}

export async function putKey(
  ctx: JoplinContext,
  kind: UserDataKind,
  id: string,
  ns: string,
  key: string,
  value: unknown,
): Promise<{ value: unknown }> {
  validateNamespaceAndKey(ns, key);
  await loadEnvelope(ctx, kind, id);
  await ctx.lib.setItemUserData(modelTypeFor(ctx, kind), id, ns, key, value);
  await ctx.events?.emit(kind, id, 'update');
  return { value };
}

export async function deleteKey(
  ctx: JoplinContext,
  kind: UserDataKind,
  id: string,
  ns: string,
  key: string,
): Promise<void> {
  validateNamespaceAndKey(ns, key);
  await loadEnvelope(ctx, kind, id);
  await ctx.lib.deleteItemUserData(modelTypeFor(ctx, kind), id, ns, key);
  await ctx.events?.emit(kind, id, 'update');
}
