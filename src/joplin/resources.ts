import { stat } from 'node:fs/promises';
import type { JoplinContext } from './bootstrap.js';
import { ItemConflictError, ItemNotFoundError, ItemValidationError } from './errors.js';
import { ID_PATTERN, type JoplinItem, type ListParams, type ListResult } from './items.js';

// Metadata callers may set; everything else on a resource is derived from
// the blob or managed by the server/sync.
const CREATE_PROPS = new Set(['id', 'title']);
const PATCH_PROPS = new Set(['title', 'user_created_time', 'user_updated_time']);

export function resourceFieldNames(ctx: JoplinContext): string[] {
  return ctx.lib.Resource.fieldNames() as string[];
}

function projectFields(item: JoplinItem, fields: string[]): JoplinItem {
  const out: JoplinItem = {};
  for (const field of fields) {
    if (field in item) out[field] = item[field];
  }
  return out;
}

async function loadResource(ctx: JoplinContext, id: string): Promise<JoplinItem | null> {
  if (!ID_PATTERN.test(id)) return null;
  const item = (await ctx.lib.Resource.load(id)) as JoplinItem | undefined;
  return item ?? null;
}

function stripLibMetadata(item: JoplinItem): JoplinItem {
  const rest = { ...item };
  delete rest.type_;
  return rest;
}

export async function listResources(ctx: JoplinContext, params: ListParams): Promise<ListResult> {
  const offset = (params.page - 1) * params.limit;
  const sql =
    `SELECT ${params.fields.join(', ')} FROM resources ` +
    `ORDER BY ${params.orderBy} ${params.orderDir}, id ${params.orderDir} ` +
    `LIMIT ${params.limit + 1} OFFSET ${offset}`;
  const rows = (await ctx.lib.Resource.modelSelectAll(sql, [])) as JoplinItem[];
  return {
    items: rows.slice(0, params.limit).map((row) => projectFields(row, params.fields)),
    has_more: rows.length > params.limit,
  };
}

export async function getResource(ctx: JoplinContext, id: string, fields: string[]): Promise<JoplinItem> {
  const item = await loadResource(ctx, id);
  if (!item) throw new ItemNotFoundError('resource', id);
  return projectFields(item, ['id', ...fields.filter((f) => f !== 'id')]);
}

export interface ResourceBlob {
  path: string;
  mime: string;
  filename: string;
  size: number;
}

export async function resourceBlob(ctx: JoplinContext, id: string): Promise<ResourceBlob> {
  const item = await loadResource(ctx, id);
  if (!item) throw new ItemNotFoundError('resource', id);
  const path = (await ctx.lib.Resource.fullPath(item)) as string;
  try {
    const info = await stat(path);
    return {
      path,
      size: info.size,
      mime: (item.mime as string) || 'application/octet-stream',
      filename: (item.filename as string) || (item.title as string) || id,
    };
  } catch {
    // Metadata can arrive via sync before the blob does.
    throw new ItemNotFoundError('resource blob (not yet downloaded?)', id);
  }
}

export async function createResourceFromFile(
  ctx: JoplinContext,
  tempPath: string,
  props: JoplinItem,
): Promise<JoplinItem> {
  for (const key of Object.keys(props)) {
    if (!CREATE_PROPS.has(key)) {
      throw new ItemValidationError(`resource prop ${JSON.stringify(key)} cannot be set on upload`);
    }
  }
  if (typeof props.id === 'string') {
    if (!ID_PATTERN.test(props.id)) {
      throw new ItemValidationError('invalid id: expected 32 lowercase hex characters');
    }
    if (await loadResource(ctx, props.id)) {
      throw new ItemConflictError(`a resource with id ${props.id} already exists`);
    }
  }

  const saved = (await ctx.lib.shim.createResourceFromPath(tempPath, props, {
    resizeLargeImages: 'never',
  })) as JoplinItem;
  ctx.events?.emit('resource', saved.id as string, 'create');
  return stripLibMetadata((await loadResource(ctx, saved.id as string))!);
}

export async function updateResource(ctx: JoplinContext, id: string, props: JoplinItem): Promise<JoplinItem> {
  const existing = await loadResource(ctx, id);
  if (!existing) throw new ItemNotFoundError('resource', id);
  for (const key of Object.keys(props)) {
    if (!PATCH_PROPS.has(key)) {
      throw new ItemValidationError(`resource field ${JSON.stringify(key)} is not writable`);
    }
  }
  await ctx.lib.Resource.save({ ...props, id });
  ctx.events?.emit('resource', id, 'update');
  return stripLibMetadata((await loadResource(ctx, id))!);
}

export async function deleteResource(ctx: JoplinContext, id: string): Promise<void> {
  const existing = await loadResource(ctx, id);
  if (!existing) throw new ItemNotFoundError('resource', id);
  // Resources have no trash in Joplin; deletion is permanent and removes
  // the blob as well.
  await ctx.lib.Resource.delete(id, { sourceDescription: 'jonobones api' });
  ctx.events?.emit('resource', id, 'delete');
}

/** Resources referenced by a note's body (:/<id> links), per Note.linkedItemIds. */
export async function resourcesOfNote(ctx: JoplinContext, noteId: string, fields: string[]): Promise<ListResult> {
  if (!ID_PATTERN.test(noteId)) throw new ItemNotFoundError('note', noteId);
  const note = (await ctx.lib.Note.load(noteId)) as JoplinItem | null;
  if (!note) throw new ItemNotFoundError('note', noteId);

  const ids = (await ctx.lib.Note.linkedItemIds((note.body as string) ?? '')) as string[];
  const items: JoplinItem[] = [];
  for (const id of ids) {
    const resource = await loadResource(ctx, id);
    if (resource) items.push(projectFields(resource, fields));
  }
  return { items, has_more: false };
}
