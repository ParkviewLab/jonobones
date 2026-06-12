// Typed data-plane operations over the Joplin models. Reads compose
// validated SELECTs (read-only SQL is safe); every WRITE goes through the
// lib model layer — Joplin keeps its sync bookkeeping (item_changes,
// deleted_items, sync_items) in application code, so raw SQL writes would
// corrupt sync state. That is the prime axiom; do not "optimize" it away.

import type { JoplinContext } from './bootstrap.js';
import { ItemConflictError, ItemNotFoundError, ItemValidationError } from './errors.js';

export type JoplinItem = Record<string, unknown>;

export interface ListParams {
  page: number;
  limit: number;
  orderBy: string;
  orderDir: 'ASC' | 'DESC';
  fields: string[];
  includeDeleted: boolean;
  parentId?: string;
}

export interface ListResult {
  items: JoplinItem[];
  has_more: boolean;
}

export const ID_PATTERN = /^[0-9a-f]{32}$/;

// Fields the server manages; rejecting them on write is part of the API
// contract (§5.1). user_data is writable only through the envelope
// endpoints (§5.7).
const SERVER_MANAGED_FIELDS = new Set(['created_time', 'updated_time', 'user_data']);
const SERVER_MANAGED_PREFIX = 'encryption_';
const WRITE_EXEMPT_FIELDS = new Set(['type_']);

export type ItemKind = 'note' | 'notebook' | 'tag';

interface KindSpec {
  kind: ItemKind;
  table: string;
  // Extra WHERE fragments applied to every list query.
  listConditions: string[];
  hasTrash: boolean;
}

const KIND_SPECS: Record<ItemKind, KindSpec> = {
  note: { kind: 'note', table: 'notes', listConditions: ['is_conflict = 0'], hasTrash: true },
  notebook: { kind: 'notebook', table: 'folders', listConditions: [], hasTrash: true },
  tag: { kind: 'tag', table: 'tags', listConditions: [], hasTrash: false },
};

/* eslint-disable @typescript-eslint/no-explicit-any -- lib model handles are untyped by design */
function modelFor(ctx: JoplinContext, kind: ItemKind): any {
  if (kind === 'note') return ctx.lib.Note;
  if (kind === 'notebook') return ctx.lib.Folder;
  return ctx.lib.Tag;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function fieldNamesFor(ctx: JoplinContext, kind: ItemKind): string[] {
  return modelFor(ctx, kind).fieldNames() as string[];
}

function assertValidId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new ItemValidationError(`invalid id: expected 32 lowercase hex characters, got ${JSON.stringify(id)}`);
  }
}

function validateWriteProps(ctx: JoplinContext, kind: ItemKind, props: JoplinItem, { forCreate }: { forCreate: boolean }): void {
  const known = new Set(fieldNamesFor(ctx, kind));
  for (const key of Object.keys(props)) {
    if (WRITE_EXEMPT_FIELDS.has(key)) {
      throw new ItemValidationError(`field ${JSON.stringify(key)} cannot be written`);
    }
    if (!known.has(key)) {
      throw new ItemValidationError(`unknown ${kind} field: ${JSON.stringify(key)}`);
    }
    if (SERVER_MANAGED_FIELDS.has(key) || key.startsWith(SERVER_MANAGED_PREFIX)) {
      const hint = key === 'user_data' ? ' (use the /userdata endpoints)' : '';
      throw new ItemValidationError(`field ${JSON.stringify(key)} is server-managed${hint}`);
    }
    if (key === 'deleted_time' || key === 'is_conflict' || key === 'conflict_original_id') {
      throw new ItemValidationError(`field ${JSON.stringify(key)} is server-managed (use delete/restore)`);
    }
    if (key === 'id' && !forCreate) {
      throw new ItemValidationError('id cannot be changed');
    }
  }
  if (forCreate && typeof props.id === 'string') assertValidId(props.id);
}

async function loadRaw(ctx: JoplinContext, kind: ItemKind, id: string): Promise<JoplinItem | null> {
  if (!ID_PATTERN.test(id)) return null;
  const item = (await modelFor(ctx, kind).load(id)) as JoplinItem | undefined;
  return item ?? null;
}

// Full-item echoes (create/update/restore) must not leak lib metadata.
function stripLibMetadata(item: JoplinItem): JoplinItem {
  const rest = { ...item };
  delete rest.type_;
  return rest;
}

function projectFields(item: JoplinItem, fields: string[]): JoplinItem {
  const out: JoplinItem = {};
  for (const field of fields) {
    if (field in item) out[field] = item[field];
  }
  return out;
}

// modelSelectAll decorates rows with lib metadata (type_); pin responses to
// exactly the requested fields.
function projectRows(rows: JoplinItem[], fields: string[], limit: number): ListResult {
  return {
    items: rows.slice(0, limit).map((row) => projectFields(row, fields)),
    has_more: rows.length > limit,
  };
}

// --- Generic CRUD ----------------------------------------------------------

export async function listItems(ctx: JoplinContext, kind: ItemKind, params: ListParams): Promise<ListResult> {
  const spec = KIND_SPECS[kind];
  const conditions = [...spec.listConditions];
  const sqlParams: unknown[] = [];

  if (spec.hasTrash && !params.includeDeleted) conditions.push('deleted_time = 0');
  if (params.parentId !== undefined) {
    conditions.push('parent_id = ?');
    sqlParams.push(params.parentId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (params.page - 1) * params.limit;
  // limit+1 detects has_more without a COUNT query. Field and order names
  // are validated against the model's field list upstream; ids break ties
  // so pagination is stable.
  const sql =
    `SELECT ${params.fields.join(', ')} FROM ${spec.table} ${where} ` +
    `ORDER BY ${params.orderBy} ${params.orderDir}, id ${params.orderDir} ` +
    `LIMIT ${params.limit + 1} OFFSET ${offset}`;

  const rows = (await modelFor(ctx, kind).modelSelectAll(sql, sqlParams)) as JoplinItem[];
  return projectRows(rows, params.fields, params.limit);
}

export async function getItem(ctx: JoplinContext, kind: ItemKind, id: string, fields: string[]): Promise<JoplinItem> {
  const item = await loadRaw(ctx, kind, id);
  if (!item) throw new ItemNotFoundError(kind, id);
  return projectFields(item, ['id', ...fields.filter((f) => f !== 'id')]);
}

export async function createItem(ctx: JoplinContext, kind: ItemKind, props: JoplinItem): Promise<JoplinItem> {
  validateWriteProps(ctx, kind, props, { forCreate: true });

  if (typeof props.id === 'string') {
    const existing = await loadRaw(ctx, kind, props.id);
    if (existing) throw new ItemConflictError(`a ${kind} with id ${props.id} already exists`);
  }

  if (kind === 'note') {
    const parentId = props.parent_id;
    if (typeof parentId !== 'string' || parentId === '') {
      throw new ItemValidationError('notes require a parent_id (the notebook id)');
    }
    const folder = await loadRaw(ctx, 'notebook', parentId);
    if (!folder) throw new ItemValidationError(`parent_id does not exist: ${parentId}`);
  }
  if (kind === 'notebook' && typeof props.parent_id === 'string' && props.parent_id !== '') {
    const parent = await loadRaw(ctx, 'notebook', props.parent_id);
    if (!parent) throw new ItemValidationError(`parent_id does not exist: ${props.parent_id}`);
  }

  const saveOptions = typeof props.id === 'string' ? { isNew: true } : undefined;
  const saved = await saveViaModel(ctx, kind, props, saveOptions);
  ctx.events?.emit(kind, saved.id as string, 'create');
  return stripLibMetadata((await loadRaw(ctx, kind, saved.id as string))!);
}

export async function updateItem(ctx: JoplinContext, kind: ItemKind, id: string, props: JoplinItem): Promise<JoplinItem> {
  const existing = await loadRaw(ctx, kind, id);
  if (!existing) throw new ItemNotFoundError(kind, id);
  validateWriteProps(ctx, kind, props, { forCreate: false });

  if (kind === 'note' && typeof props.parent_id === 'string') {
    const folder = await loadRaw(ctx, 'notebook', props.parent_id);
    if (!folder) throw new ItemValidationError(`parent_id does not exist: ${props.parent_id}`);
  }

  await saveViaModel(ctx, kind, { ...props, id });
  ctx.events?.emit(kind, id, 'update');
  return stripLibMetadata((await loadRaw(ctx, kind, id))!);
}

async function saveViaModel(
  ctx: JoplinContext,
  kind: ItemKind,
  props: JoplinItem,
  saveOptions?: Record<string, unknown>,
): Promise<JoplinItem> {
  try {
    return (await modelFor(ctx, kind).save({ ...props }, saveOptions)) as JoplinItem;
  } catch (error) {
    // The lib validates moves/titles with plain Errors meant for users
    // (e.g. "Cannot move notebook to this location"); surface as 400s.
    throw new ItemValidationError((error as Error).message);
  }
}

export async function deleteItem(
  ctx: JoplinContext,
  kind: ItemKind,
  id: string,
  { permanent }: { permanent: boolean },
): Promise<void> {
  const existing = await loadRaw(ctx, kind, id);
  if (!existing) throw new ItemNotFoundError(kind, id);

  if (kind === 'tag') {
    // Tags have no deleted_time anywhere in the Joplin schema: tag deletion
    // is always permanent, and untagAll also detaches every note first.
    await ctx.lib.Tag.untagAll(id);
    ctx.events?.emit('tag', id, 'delete');
    return;
  }

  const toTrash = !permanent;
  if (kind === 'note') {
    await ctx.lib.Note.batchDelete([id], { toTrash, sourceDescription: 'jonobones api' });
  } else {
    await ctx.lib.Folder.batchDelete([id], { toTrash, deleteChildren: true, sourceDescription: 'jonobones api' });
  }
  // Trash is an update (the item still exists, deleted_time changed);
  // only a permanent delete is a delete.
  ctx.events?.emit(kind, id, permanent ? 'delete' : 'update');
}

export async function restoreItem(ctx: JoplinContext, kind: ItemKind, id: string): Promise<JoplinItem> {
  if (kind === 'tag') throw new ItemValidationError('tags have no trash; tag deletion is permanent');
  const existing = await loadRaw(ctx, kind, id);
  if (!existing) throw new ItemNotFoundError(kind, id);
  if (!existing.deleted_time) throw new ItemConflictError(`${kind} ${id} is not in the trash`);

  const modelType = kind === 'note' ? ctx.lib.ModelType.Note : ctx.lib.ModelType.Folder;
  await ctx.lib.restoreItems(modelType, [id], { useRestoreFolder: true });
  ctx.events?.emit(kind, id, 'update');
  return stripLibMetadata((await loadRaw(ctx, kind, id))!);
}

// --- Tag links --------------------------------------------------------------

export async function tagsOfNote(ctx: JoplinContext, noteId: string, params: ListParams): Promise<ListResult> {
  const note = await loadRaw(ctx, 'note', noteId);
  if (!note) throw new ItemNotFoundError('note', noteId);

  const offset = (params.page - 1) * params.limit;
  const sql =
    `SELECT ${params.fields.map((f) => `tags.${f}`).join(', ')} FROM tags ` +
    'INNER JOIN note_tags ON note_tags.tag_id = tags.id WHERE note_tags.note_id = ? ' +
    `ORDER BY tags.${params.orderBy} ${params.orderDir}, tags.id ${params.orderDir} ` +
    `LIMIT ${params.limit + 1} OFFSET ${offset}`;
  const rows = (await ctx.lib.Tag.modelSelectAll(sql, [noteId])) as JoplinItem[];
  return projectRows(rows, params.fields, params.limit);
}

export async function notesOfTag(ctx: JoplinContext, tagId: string, params: ListParams): Promise<ListResult> {
  const tag = await loadRaw(ctx, 'tag', tagId);
  if (!tag) throw new ItemNotFoundError('tag', tagId);

  const conditions = ['note_tags.tag_id = ?', 'notes.is_conflict = 0'];
  if (!params.includeDeleted) conditions.push('notes.deleted_time = 0');
  const offset = (params.page - 1) * params.limit;
  const sql =
    `SELECT ${params.fields.map((f) => `notes.${f}`).join(', ')} FROM notes ` +
    `INNER JOIN note_tags ON note_tags.note_id = notes.id WHERE ${conditions.join(' AND ')} ` +
    `ORDER BY notes.${params.orderBy} ${params.orderDir}, notes.id ${params.orderDir} ` +
    `LIMIT ${params.limit + 1} OFFSET ${offset}`;
  const rows = (await ctx.lib.Note.modelSelectAll(sql, [tagId])) as JoplinItem[];
  return projectRows(rows, params.fields, params.limit);
}

export async function attachTag(ctx: JoplinContext, tagId: string, noteId: string): Promise<void> {
  const tag = await loadRaw(ctx, 'tag', tagId);
  if (!tag) throw new ItemNotFoundError('tag', tagId);
  const note = await loadRaw(ctx, 'note', noteId);
  if (!note) throw new ItemNotFoundError('note', noteId);
  await ctx.lib.Tag.addNote(tagId, noteId);
  // Thin events: the note's tag set changed; clients re-fetch its tags.
  ctx.events?.emit('note', noteId, 'update');
}

export async function detachTag(ctx: JoplinContext, tagId: string, noteId: string): Promise<void> {
  const tag = await loadRaw(ctx, 'tag', tagId);
  if (!tag) throw new ItemNotFoundError('tag', tagId);
  const note = await loadRaw(ctx, 'note', noteId);
  if (!note) throw new ItemNotFoundError('note', noteId);
  await ctx.lib.Tag.removeNote(tagId, noteId);
  ctx.events?.emit('note', noteId, 'update');
}
