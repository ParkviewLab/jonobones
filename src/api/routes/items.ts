import type { FastifyInstance } from 'fastify';
import type { JoplinContext } from '../../joplin/bootstrap.js';
import {
  attachTag,
  createItem,
  deleteItem,
  detachTag,
  fieldNamesFor,
  getItem,
  listItems,
  notesOfTag,
  restoreItem,
  tagsOfNote,
  updateItem,
  type ItemKind,
} from '../../joplin/items.js';
import { ID_PATTERN } from '../../joplin/items.js';
import { ApiError } from '../errors.js';
import { parseBooleanFlag, parseFields, parseListQuery, requireObjectBody } from '../pagination.js';

const KIND_BY_PLURAL: Record<string, ItemKind> = {
  notes: 'note',
  notebooks: 'notebook',
  tags: 'tag',
};

type Params = { id: string };
type Query = Record<string, unknown>;

export function registerItemRoutes(v1: FastifyInstance, ctx: JoplinContext): void {
  for (const [plural, kind] of Object.entries(KIND_BY_PLURAL)) {
    const modelFields = () => fieldNamesFor(ctx, kind);

    v1.get(`/${plural}`, async (request) => {
      const params = parseListQuery(request.query as Query, {
        modelFields: modelFields(),
        allowParentFilter: kind === 'note',
      });
      return listItems(ctx, kind, params);
    });

    v1.post(`/${plural}`, async (request, reply) => {
      const body = requireObjectBody(request.body);
      const item = await createItem(ctx, kind, body);
      return reply.code(201).send(item);
    });

    v1.get(`/${plural}/:id`, async (request) => {
      const { id } = request.params as Params;
      const fields = parseFields(request.query as Query, modelFields());
      return getItem(ctx, kind, id, fields);
    });

    v1.patch(`/${plural}/:id`, async (request) => {
      const { id } = request.params as Params;
      const body = requireObjectBody(request.body);
      return updateItem(ctx, kind, id, body);
    });

    v1.delete(`/${plural}/:id`, async (request, reply) => {
      const { id } = request.params as Params;
      const permanent = kind === 'tag' ? true : parseBooleanFlag(request.query as Query, 'permanent');
      await deleteItem(ctx, kind, id, { permanent });
      return reply.code(204).send();
    });

    if (kind !== 'tag') {
      v1.post(`/${plural}/:id/restore`, async (request) => {
        const { id } = request.params as Params;
        return restoreItem(ctx, kind, id);
      });
    }
  }

  v1.get('/notes/:id/tags', async (request) => {
    const { id } = request.params as Params;
    const params = parseListQuery(request.query as Query, { modelFields: fieldNamesFor(ctx, 'tag') });
    return tagsOfNote(ctx, id, params);
  });

  v1.get('/tags/:id/notes', async (request) => {
    const { id } = request.params as Params;
    const params = parseListQuery(request.query as Query, { modelFields: fieldNamesFor(ctx, 'note') });
    return notesOfTag(ctx, id, params);
  });

  v1.post('/tags/:id/notes', async (request, reply) => {
    const { id } = request.params as Params;
    const body = requireObjectBody(request.body);
    const noteId = body.id;
    if (typeof noteId !== 'string' || !ID_PATTERN.test(noteId)) {
      throw new ApiError(400, 'bad_request', 'body must be {"id": "<32-hex note id>"}');
    }
    await attachTag(ctx, id, noteId);
    return reply.code(204).send();
  });

  v1.delete('/tags/:id/notes/:noteId', async (request, reply) => {
    const { id, noteId } = request.params as Params & { noteId: string };
    await detachTag(ctx, id, noteId);
    return reply.code(204).send();
  });
}
