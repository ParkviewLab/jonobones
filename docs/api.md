# jonobones API reference (`/v1`)

Base URL: `http://127.0.0.1:26637/v1` (port configurable; loopback only).
`apiVersion` is `1`; the `/v1` prefix bumps only on breaking change.

## Conventions

### Authentication

Every endpoint except `GET /health` requires the API token:

- `Authorization: Bearer <token>` (preferred), or
- `?token=<token>` (exists for `EventSource`/SSE clients, accepted everywhere).

Missing/wrong token → `401` with the error envelope. The token lives in
`config.json5` and, while the daemon runs, in `lock.json` (both `0600`).

### Errors

All errors are
`{"error": {"code": "<machine_code>", "message": "<human text>"}}` with an
honest HTTP status: `400 bad_request`, `401 unauthorized`, `404 not_found`,
`409 conflict`, `500 internal_error`.

### Pagination (list endpoints)

`?page=` (1-based, default 1) · `?limit=` (default 100, **max 1000**) ·
`?order_by=` (any field of the type; default `updated_time`) ·
`?order_dir=asc|desc` (default `desc`). Responses:
`{"items": [...], "has_more": true|false}`. Ordering is made stable with an
id tiebreak.

### Field selection

`?fields=a,b,c` — comma-separated field names of the underlying Joplin type.
Default: `id,parent_id,title,updated_time` (intersected with the type's
fields). Unknown fields → `400`. `POST`/`PATCH`/restore echo the **full**
item regardless.

`user_data` may be *read* via `?fields=user_data` (the raw envelope string);
it is never writable directly — see [user_data](#user_data).

### Writes

- `POST` creates; you may supply your own `id` (32 lowercase hex — the
  Joplin id format). Reusing an existing id → `409`.
- `PATCH` merges the provided fields, echoes the full updated item.
- Server-managed fields are rejected with `400`: `created_time`,
  `updated_time`, `encryption_*`, `user_data` (envelope endpoints instead),
  `deleted_time`, `is_conflict`, `conflict_original_id`, `type_`, and `id`
  changes. `user_created_time` / `user_updated_time` **are** writable.
- Unknown fields → `400`.

### Trash

`DELETE /notes/{id}` and `DELETE /notebooks/{id}` move to Joplin's trash
(`deleted_time` set; notebook trash cascades to children, like Joplin).
`?permanent=true` deletes outright. `POST /{type}/{id}/restore` untrashes
(notebook restore cascades back; restoring a non-trashed item → `409`).
Lists exclude trashed items unless `?include_deleted=true`; `GET` by id
still returns them.

**Tags have no trash** — `DELETE /tags/{id}` is always permanent and
detaches the tag from all notes first. Resources are also deleted
permanently (no `deleted_time` in the Joplin schema).

## Service

| Endpoint | Description |
| --- | --- |
| `GET /health` | `{"app":"jonobones","version":"0.1.0","apiVersion":1}` — **no auth** |
| `GET /status` | `{sync:{state,lastStartedAt,lastCompletedAt,lastResult,target,pendingUpload,conflictCount}, e2ee:{enabled,pendingDecryption}, profile:{path,schemaVersion}, events:{oldestId,newestId}}` |
| `POST /sync` | trigger a sync now → `202 {"syncing":true,"alreadyRunning":bool}` |

`sync.state` is `unconfigured` · `idle` · `syncing` · `error`.

## Notes

| Endpoint | Notes |
| --- | --- |
| `GET /notes` | supports `?parent_id=<notebook id>` filter |
| `POST /notes` | requires `parent_id`; `title`, `body` (Markdown), `is_todo`, … |
| `GET /notes/{id}` | `?fields=` applies (default is the minimal four — ask for `body` explicitly) |
| `PATCH /notes/{id}` | merge semantics |
| `DELETE /notes/{id}` | trash; `?permanent=true` hard-deletes |
| `POST /notes/{id}/restore` | untrash |
| `GET /notes/{id}/tags` | tags attached to the note |
| `GET /notes/{id}/resources` | resources referenced by the note body (`:/​<id>` links) |

## Notebooks (Joplin folders)

`GET /notebooks` returns the **flat** list (each row carries `parent_id`;
clients build the tree) · `POST /notebooks` · `GET|PATCH|DELETE
/notebooks/{id}` · `POST /notebooks/{id}/restore`.

## Tags

`GET /tags` · `POST /tags` · `GET|PATCH|DELETE /tags/{id}` ·
`GET /tags/{id}/notes` · `POST /tags/{id}/notes` with body
`{"id": "<note id>"}` attaches · `DELETE /tags/{id}/notes/{noteId}`
detaches.

## Resources

| Endpoint | Notes |
| --- | --- |
| `GET /resources` | metadata list |
| `POST /resources` | `multipart/form-data`: file part `data` (the blob) + optional field `props` (JSON: `{id?, title?}`) → `201` metadata |
| `GET /resources/{id}` | metadata |
| `GET /resources/{id}/file` | the blob, with `content-type`/`content-length`/`content-disposition`; `404` if the blob hasn't been downloaded from the sync target yet |
| `PATCH /resources/{id}` | `title`, `user_created_time`, `user_updated_time` only |
| `DELETE /resources/{id}` | permanent (blob removed too) |

```sh
curl -H "Authorization: Bearer $TOKEN" \
  -F 'props={"title":"photo.jpg"}' -F 'data=@photo.jpg' \
  http://127.0.0.1:26637/v1/resources
```

## user_data

Joplin's per-item `user_data` is a conflict-merged envelope:
`{ "<namespace>": { "<key>": { "v": <value>, "t": <epoch_ms>, "d"?: 1 } } }`
with per-key last-write-wins on `t` and tombstoned deletes. Hand-written raw
JSON silently breaks merging, so jonobones only exposes envelope-safe
operations (implemented with Joplin's own helpers — they also bump
`updated_time` so changes sync):

| Endpoint | Description |
| --- | --- |
| `GET /{type}/{id}/userdata/{ns}` | all live keys → `{"key": value, ...}` |
| `GET /{type}/{id}/userdata/{ns}/{key}` | `{"value": ...}`; `404` if absent or tombstoned |
| `PUT /{type}/{id}/userdata/{ns}/{key}` | body `{"value": <any JSON>}` |
| `DELETE /{type}/{id}/userdata/{ns}/{key}` | tombstones the key |

`{type}` ∈ `notes`, `notebooks`, `tags`, `resources`. Namespaces and keys
are 1–255 characters. Pick a namespace that identifies your application and
stay inside it.

## Search, revisions, conflicts (read-only)

- `GET /search?q=<query>` — Joplin full-text search over notes; results in
  relevance order; `?fields=`/`?limit=` apply, `has_more` only.
- `GET /revisions` — the note-history table (populates while the daemon
  runs, as in stock clients).
- `GET /conflicts` — notes with `is_conflict=1`; default fields include
  `conflict_original_id`. Conflict copies never appear in `GET /notes`.

## Events

`GET /events` is content-negotiated:

### SSE (`Accept: text/event-stream`)

```sh
curl -N "http://127.0.0.1:26637/v1/events?token=$TOKEN" -H 'Accept: text/event-stream'
```

- Each change is `event: change` with `id: <journal id>` and `data:`
  `{"id":N,"item_type":"note|notebook|tag|resource","item_id":"…","change_type":"create|update|delete","source":"api|sync"}`
- Events are **thin**: re-fetch the item for its current state. Trash and
  restore are `update`s; only permanent deletion is `delete`. A `404` on
  re-fetch after an `update` just means it changed again — keep following
  the stream.
- Heartbeat comment (`: ping`) every ~30 s.
- Reconnect with `Last-Event-ID` (standard `EventSource` behavior) — missed
  events replay from the journal.
- If your cursor is older than the journal's retention (default 30 days)
  or otherwise unknown, you get `event: reset` with
  `data: {"resumeFrom": N}`: **full-reload** your state via REST, then
  continue from `N`.

### JSON polling (anything else)

`GET /events?cursor=N&limit=…` → `{"items":[…],"cursor":M,"has_more":bool}`.
Poll with the returned `cursor`. A non-resumable cursor returns
`{"reset":true,"cursor":<current newest>,"items":[],"has_more":false}` —
full-reload, then poll from that cursor.

### The snapshot race (read this once)

To bootstrap a client without losing changes:

1. **Open the stream first** (SSE connect, or note the current `cursor`
   from `GET /events?cursor=0&limit=1` / `GET /status` → `events.newestId`),
   buffering whatever arrives.
2. **Then snapshot** via the REST endpoints.
3. **Then apply** the buffered/queued events on top of the snapshot.

Events are idempotent re-fetch triggers, so applying an event that the
snapshot already contains is harmless. Doing it the other way around
(snapshot, then subscribe) loses anything that changed in between.

## Things the API will not do

Configuration and secrets never travel over HTTP: no endpoint reads or
writes `config.json5`, sync credentials, the E2EE master password, or the
API token (`POST /sync` is operational, not configuration). Provisioning is
the CLI's job (`jonobones init`, `service install`, …).
