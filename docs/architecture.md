# jonobones architecture

Read [northstar.md](northstar.md) first — every decision below answers to
it, especially the prime axiom: **the managed profile stays a 100% stock
Joplin client profile.**

## One process, three planes

```
          HTTP /v1 (127.0.0.1)                 Joplin sync protocol
client ◄──────────────────────► jonobones ◄──────────────────────► target
                                 daemon
            data plane         control plane = CLI (init/start/stop/…)
```

- **Data plane** — the REST API: knowledge in, knowledge out, plus the
  operational `POST /sync` and `GET /status`.
- **Control plane** — the CLI: provisioning, credentials, service
  registration. No config mutation and no secrets over HTTP, ever.
- **Sync plane** — `@joplin/lib`'s own Synchronizer, run by a scheduler
  (immediate on boot + every `sync.interval` seconds + on demand).

## Source layout

```
src/
  joplin/     ← THE anti-corruption layer. The only directory allowed to
                import @joplin/* (ESLint-enforced). Bootstraps the lib
                headless, wraps models, sync, search, userdata, E2EE.
  api/        ← Fastify routes for /v1: auth hook, conventions, SSE.
  events/     ← jonobones-owned event journal (own SQLite file) + hub + scan.
  sync/       ← the scheduler (single-flight, interval + on-demand).
  cli/        ← init wizard, start/stop/status/sync/service commands.
  config/     ← JSON5 config, env/flag overlay, profile dirs, lockfile.
```

### Why an anti-corruption layer

`@joplin/lib` is published CommonJS with **no main entry and no API
stability guarantee** — every import is a deep file path. jonobones pins an
exact version (`3.6.3`) and quarantines every import behind
`src/joplin/`. The rest of the codebase sees typed wrappers and domain
errors, never the lib. When upstream moves: re-pin, fix `src/joplin/`,
re-run the interop suite. Nothing else should need to change.

### Why every write goes through the model layer

Joplin keeps all its bookkeeping — `item_changes`, `deleted_items`,
`sync_items`, revision tracking — in **application code**, not database
triggers. A raw SQL write would update a row without recording that it
changed, and sync would silently skip it. Reads compose validated SELECTs
(safe); writes call `Note.save()`, `Folder.batchDelete()`, Joplin's own
`setItemUserData`, `restoreItems`, `shim.createResourceFromPath`, etc.

### Headless lib bootstrap (hard-won facts)

`src/joplin/bootstrap.ts` mirrors the lib's own test bootstrap
(`testing/test-utils.ts` + `jest.setup.js`), proven by the M0 spike
(`spike/lib-spike.mjs`, kept alive as an integration test):

- `shimInit` must receive `nodeSqlite` (the `sqlite3` module) — the DB
  driver resolves it via `shim.nodeSqlite()`.
- `shim.appVersion()` feeds the sync-target compatibility handshake
  (`checkIfCanSync`), so it reports the **embedded `@joplin/lib`
  version**, never the jonobones product version.
- `FsDriverNode` must be injected as statics on
  `Logger`/`Resource`/`EncryptionService`/`FileApiDriverLocal`.
- `DecryptionWorker` needs both the `EncryptionService` and a `KvStore`.
- Lib state is process-global (Setting constants, `BaseModel` db, service
  singletons): **one Joplin context per process**, enforced.

## Profile layout

```
~/.config/jonobones/<profile>/
├── config.json5      0600 — canonical config (token, sync creds, E2EE pw)
├── lock.json         0600 — pid/port/token/profile/startedAt/version
├── events.sqlite     jonobones' event journal — its own file, NEVER a
│                     table inside Joplin's database
└── joplin/           a 100% stock Joplin client profile
    ├── database.sqlite
    ├── settings.json
    └── resources/
```

`config.json5` is canonical: every boot re-applies the mapped values into
Joplin's Setting store (`sync.target`, `sync.N.*`,
`encryption.masterPassword`), so the stock profile always reflects the
config, never the other way around.

## Sync cycle

1. Scheduler triggers (boot / interval / `POST /sync`); single-flight —
   concurrent triggers report `alreadyRunning`.
2. `Synchronizer.start()` with the persisted sync context (delta sync).
3. Post-sync pass, exactly what stock clients do:
   - reload master keys + run the `DecryptionWorker` (E2EE targets),
   - `ResourceFetcher` downloads resource blobs whose metadata arrived,
   - `RevisionService.collectRevisions()` accumulates note history,
   - the **event scan** (below).
4. Status (`/status`) reflects state, timestamps, last result, pending
   uploads, conflicts.

E2EE: the local database is always plaintext **by design** (encryption
applies to the sync-target copies); the master password is needed at every
boot, which is why it lives in the 0600 config rather than a prompt.

## Events

`events.sqlite` holds an append-only journal with monotonically increasing
ids — the SSE `id:` and JSON `cursor` are journal ids. Two producers:

- **API writes** publish synchronously: the HTTP response returns only
  after the event is durably journaled.
- **The post-sync scan** diffs `updated_time > checkpoint` across
  notes/folders/tags/resources (`source: "sync"`; items already announced
  by the API since the checkpoint are skipped). Remote **permanent**
  deletes never bump a surviving row, so they are detected by **id
  reconciliation** against a known-id snapshot kept in the journal DB.
  This was chosen over consuming Joplin's `item_changes` type-3 rows:
  their folder/tag coverage is unverified upstream, while the id diff is
  dependable for every type by construction.

Events are deliberately thin (`item_type`, `item_id`, `change_type`,
`source`) — clients re-fetch; that makes duplicates and races harmless and
is what permits the simple scan. Retention defaults to 30 days; a cursor
older than retention triggers the documented `reset` flow.

## What jonobones never does

- Add tables, triggers, or files inside the Joplin profile.
- Write the Joplin database with raw SQL.
- Serve configuration or secrets over HTTP.
- Bind beyond loopback by default (Docker overrides the bind inside the
  container boundary only).
- Know anything about any particular client application.
