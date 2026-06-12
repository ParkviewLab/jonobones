# Testing

jonobones has four test tiers. Each one trusts the tier below it and
proves something the tier below cannot.

| Tier | Command | Needs | Proves |
|---|---|---|---|
| Unit | `npm test` (part of) | nothing | config precedence, pagination, lockfile, journal logic |
| Integration | `npm test` (part of) | nothing | every `/v1` endpoint over real HTTP, SSE mechanics, sync cycles against a filesystem target |
| Interop | `npm run test:interop` | official `joplin` CLI | byte-faithful round-trips with a stock client over a shared filesystem target, plaintext + E2EE |
| E2E | `npm run test:e2e` | Docker (+ `joplin` CLI for 4 of 5 suites) | the whole product story through a **real Joplin Server**: sync fidelity, SSE events, E2EE, restarts, conflicts, outages — and the container image deployed as users deploy it |

`npm test` never touches Docker — the e2e tier lives in its own vitest
config (`vitest.e2e.config.ts`) and only runs when asked. Interop and
e2e suites skip themselves (with a warning) when their prerequisites
are missing, so a bare `npm test` works on any machine.

The test files are canonical; the enumeration below mirrors them so a
reader can audit exactly what is proven without opening the code. When
tests change, this file changes in the same commit.

## Prerequisites

- **Official joplin CLI** — either on `PATH` (`npm install -g joplin`)
  or pointed at directly:

  ```sh
  mkdir -p /tmp/joplin-cli && (cd /tmp/joplin-cli && npm install joplin)
  export JOPLIN_CLI_BIN=/tmp/joplin-cli/node_modules/.bin/joplin
  ```

- **Docker** (e2e only) — a running daemon. The suites pull
  `joplin/server:3.7.1` on first use (override with the
  `JOPLIN_SERVER_IMAGE` env var; CI pins the same tag and caches the
  image as a tarball). The container suite additionally builds the
  repo's own Dockerfile as `jonobones:e2e`.

## Unit tier — `tests/unit/`

Pure logic, no daemon, no network.

**config.test.ts** — configuration loading and validation:
- defaults apply when no file/env/flags are present
- `config.json5` is parsed as JSON5 (comments, trailing commas) and overrides defaults
- precedence holds: env overrides file, flags override env
- env names map correctly (`JONOBONES_API_PORT` → `api.port`, snake
  segments → camelCase, `JONOBONES_E2EE_PASSWORD` aliases
  `e2ee.masterPassword`, values are type-coerced)
- malformed config files are rejected with a clear error
- `validateConfigForServe` requires a non-empty token and an in-range port
- `resolveProfileDir` treats bare names as profile names under the
  config root, and anything with separators or dots as a path

**lockfile.test.ts** — single-instance enforcement:
- acquires the lock, persists it `0600`, reads it back, releases it
- throws `AlreadyRunningError` while the holding process is alive
- replaces a stale lock left by a dead process
- treats corrupt lock files as stale
- refuses to release a lock owned by another pid

**journal.test.ts** — the events journal (`events.sqlite`):
- appends with strictly increasing ids; lists after a cursor
- prunes by age and reports cursor resumability honestly
- empty journal: cursor 0 is resumable, anything else is not
- persists metadata and known-id snapshots (the delete-reconciliation state)

**api.test.ts** — server shell without a database:
- `GET /v1/health` responds without auth with `app`/`version`/`apiVersion`
- auth hook: missing token → 401 envelope; wrong bearer → 401;
  valid `Authorization: Bearer` and valid `?token=` both pass through

**pagination.test.ts** — request-shape validators:
- `parseListQuery` applies defaults, parses explicit values, rejects bad
  pages/limits/order fields/directions, and honors `parent_id` only where allowed
- `parseFields` dedupes and validates field selections
- `requireObjectBody` accepts objects and rejects everything else

**sync-target.test.ts** — `resolveSyncTarget` mapping (pure):
- returns null when no target is configured (API-only mode)
- rejects unknown targets; lists missing required keys by name
- maps filesystem, webdav/joplinServer credentials, s3 (including
  `forcePathStyle` and optional region), and the dropbox auth blob onto
  the right `sync.N.*` Joplin settings

**service-units.test.ts** — service-manager integration files:
- derives launchd paths on darwin and systemd paths on linux (labels sanitized); rejects other platforms
- generated launchd plist contains the full start invocation and log paths, with XML-sensitive characters escaped
- generated systemd unit restarts on failure and runs in the foreground

## Integration tier — `tests/integration/`

A real daemon (`startDaemon`, in-process) on a temp profile, exercised
over real HTTP. Sync tests use a filesystem target in a temp dir; the
spike script doubles as an independent second Joplin client.

**lib-spike.test.ts** — the M0 derive spike, kept alive as a test:
- two fresh `@joplin/lib` profiles exchange a notebook + note through a
  filesystem sync target (title and Unicode body arrive intact)

**api-crud.test.ts** — the core data plane:
- notebooks: create/fetch/patch; caller-chosen 32-hex ids accepted, reuse → 409; nesting under a missing parent rejected
- notes: `parent_id` required on create; create echoes the full item;
  lists honor default fields, parent filter, pagination, ordering;
  `fields=` projection on GET; PATCH merges provided fields and rejects
  server-managed ones; trash → excluded from lists →
  `include_deleted=true` shows it → restore → `?permanent=true` deletes;
  notebook trash cascades to children and restore brings them back;
  missing/malformed ids → 404 with the error envelope
- tags: create; attach/detach with both list directions
  (`/tags/:id/notes`, `/notes/:id/tags`); tag DELETE is always permanent
  and detaches notes
- every data route 401s without a token

**api-extras.test.ts** — userdata, resources, search, revisions, conflicts:
- userdata: PUT/GET key, GET namespace; raw `user_data` carries Joplin's
  envelope (`{ns: {key: {v, t}}}`); DELETE leaves a `d:1` tombstone and
  GET turns 404; writes bump `updated_time` so they sync; works on
  notebooks and tags too; inputs validated
- resources: multipart upload echoes metadata; the downloaded blob is
  byte-identical with content headers; list/get follow the §5.1
  conventions; a resource linked from a note body appears under
  `/notes/:id/resources`; PATCH allows `title`/`user_*` only and DELETE
  is permanent; caller-chosen ids accepted, missing `data` part → 400
- search finds notes by body content
- `/revisions` returns the (empty) table with conventions applied;
  `/conflicts` lists `is_conflict` notes including `conflict_original_id`

**sync-cycle.test.ts** — the scheduler against a filesystem target:
- `/status` reports the configured target before any sync
- a peer's pushed items arrive on sync (pull)
- API writes reach the target and the peer sees them (push)
- `pendingUpload` counts unsynced local writes
- `POST /sync` answers 202 and tolerates double triggers (single-flight)

**events.test.ts** — the journal, SSE, and sync-sourced events:
- API writes journal `create`/`update`(×3 for trash/restore/edit)/`delete`
  with `source: 'api'`, ids strictly increasing
- userdata writes and tag attach/detach emit note `update` events
- JSON polling paginates with `cursor`/`has_more`; a future cursor → `reset: true`
- SSE: full replay from `Last-Event-ID: 0`, then live events on the open
  stream (`id:` matches the journal id; payload is the thin event)
- SSE: a stale (future) cursor gets an `event: reset` frame with `resumeFrom`
- a peer-pushed note arrives as `create` with `source: 'sync'` after a sync
- deleting the peer's item file from the target → next sync emits
  `delete` with `source: 'sync'` (known-id reconciliation) and the note 404s
- `/status` reports the journal's `oldestId`/`newestId`

## Interop tier — `tests/interop/`

The load-bearing proof of "Joplin-sync-compatible": jonobones and the
**official joplin CLI** share a filesystem sync target. Assertions on
the CLI side read its own `database.sqlite` — the data its sync engine
wrote, not parsed terminal output.

**joplin-cli.test.ts** — plaintext, both directions:

*jonobones → CLI:*
1. Through the jonobones API: create a notebook, a note with a Unicode
   body, a tag (attached to the note), a multipart file upload linked
   into the note body, and a `user_data` value via the envelope endpoint.
2. `POST /sync`; wait for idle.
3. The CLI configures the same target and syncs.
4. Assert in the CLI's database: note title, byte-identical body
   (including the resource link), `parent_id`, **byte-identical raw
   `user_data`**; notebook and tag titles; the note↔tag link row; the
   resource row's mime; the blob file's exact contents on the CLI side.

*CLI → jonobones:*
1. The CLI creates a notebook and note (`mkbook`/`use`/`mknote`), sets a
   Unicode body, adds a tag, attaches a file — and edits the
   jonobones-born note's title by id.
2. CLI syncs; daemon syncs.
3. Assert over the jonobones API: search finds the CLI note; body
   contains the CLI's text; tags list exactly matches; the attachment
   downloads byte-identical via `/resources/:id/file`; the CLI's edit to
   the jonobones note arrived; **`user_data` survived the foreign
   client's edit cycle byte-identically**.

**joplin-cli-e2ee.test.ts** — encryption over the shared target:

1. *jonobones encrypts like a stock client*: daemon creates a secret
   note, enables E2EE via lib (`generateMasterKeyAndEnableEncryption`),
   syncs; the serialized `.md` on the target contains
   `encryption_applied: 1` and neither the title nor body in plaintext;
   `info.json` has `e2ee: true`.
2. *The official CLI decrypts it*: CLI configures the target and the
   shared master password, syncs, runs `e2ee decrypt`; its database has
   the plaintext title/body with `encryption_applied = 0`.
3. *jonobones decrypts what the CLI encrypted*: CLI creates a new secret
   note and syncs; the daemon syncs and its post-sync decryption worker
   runs; `/search` returns the plaintext body; `/status` shows
   `e2ee.enabled: true`, `pendingDecryption: 0`.

## E2E tier — `tests/e2e/`

Five suites; each boots its **own Joplin Server container**
(`joplin/server:3.7.1`, labelled `jonobones-e2e`; a global-setup sweep
removes leftover containers, volumes, and networks from crashed runs).
The server runs with `JOPLIN_IS_TESTING=1` — Joplin's own test switch —
because every CLI sync is a fresh process doing its own login, and the
server's per-IP brute-force limiter (10/min) would otherwise starve a
suite. Three actors appear throughout:

- the **official joplin CLI** (a stock client, target 9),
- the **daemon** (in-process via `startDaemon`, or spawned from
  `bin/jonobones.js` wherever a restart is involved — `@joplin/lib` is
  process-global, so a daemon can only be restarted as a process),
- the **example app** (`examples/jonobones-app.mjs`, a zero-dependency
  REST/SSE client driven as a child process — exactly how a consumer
  would use the API).

Two timing rules every suite encodes:

- **The baseline rule.** The daemon's first post-sync scan only
  snapshots known item ids — it emits no events, by design. Every suite
  runs one baseline sync in `beforeAll`; event assertions only make
  sense after it, and a remote *delete* can only be detected for an
  item that was synced and scanned in first.
- **Idle means done.** `/status` reports `idle` only after the
  post-sync event scan, decryption, and resource downloads finish, so
  "POST `/sync`, poll until idle" needs no extra settling time.

One robustness rule: the official CLI prints `Completed` and exits 0
even when a sync silently does nothing (verified against a dead
server), so where a silent no-op would poison a whole suite, the
harness syncs **until a server-side postcondition holds**
(`cliSyncUntil`) instead of trusting exit codes.

### server-sync.test.ts — sync fidelity through a real server

1. **Provisioning**: after the baseline sync, `/status` reports
   `target: joplinServer`, state `idle`, a completion timestamp.
2. **CLI seeds → daemon syncs them down**: CLI creates a notebook and
   note, sets a Unicode body, adds a tag, attaches a file, syncs; the
   daemon syncs; assert over REST: search finds the note, the body
   matches, `/notes/:id/tags` lists the tag, and the attachment
   downloads byte-identical via `/resources/:id/file`.
3. **App writes → CLI syncs them down**: the example app creates a
   notebook and note, attaches a file (multipart + body link), tags it,
   and writes a `user_data` value; app triggers `sync --wait`; CLI
   syncs; assert in the CLI's database: title, body (with resource
   link), parent, the note↔tag link, the resource row and blob bytes,
   and the **`user_data` envelope with the value intact**.
4. **Edits converge; trash and restore round-trip**: CLI retitles the
   app's note while the daemon re-bodies the CLI's note; after syncs in
   both directions each side sees the other's edit. CLI trashes its
   note (`rmnote --force`); after syncs the daemon reports
   `deleted_time > 0` and excludes it from lists; the app restores it
   over REST; after syncs the CLI's database shows `deleted_time = 0`.
5. **Server-side permanent delete**: delete the note's item through the
   server's own API (`DELETE /api/items/root:/<id>.md:` — records a
   delta change like any remote client's hard delete); the daemon syncs;
   `GET /notes/:id` → 404.
6. **The shipped binary boots from a hand-written config**: write a
   minimal `config.json5` (port, token, target 9 block) into a fresh
   profile, spawn `node bin/jonobones.js start`, poll `/v1/health`,
   sync, and find a note seeded earlier via `/search`; SIGTERM exits 0.

### server-events.test.ts — the SSE loop end to end

The app's `watch` subcommand holds the SSE connection and emits NDJSON;
tests await `{"type":"open"}` before triggering the change under test.

1. **CLI changes arrive as `source: 'sync'`**: with a watcher open, the
   CLI creates a notebook + note and syncs; the daemon syncs; the
   watcher receives `create`/`note` with `source: 'sync'` for the note —
   and a notebook event too.
2. **App writes arrive as `source: 'api'`**: with a fresh watcher, the
   app creates a notebook + note; the events arrive with `source: 'api'`
   and no sync involved.
3. **`Last-Event-ID` resume is exact**: with no watcher attached, the
   CLI creates a note and both sides sync (events journal with no
   subscriber); reconnect with `Last-Event-ID` set to the last seen id;
   the missed events replay — all ids greater than the cursor, in
   order, no duplicates.
4. **Remote permanent deletes are evented**: delete a previously synced
   note server-side; the daemon syncs; the watcher receives
   `delete` with `source: 'sync'`, and the note 404s over REST.

### server-e2ee.test.ts — encryption over the server

The daemon enables E2EE; the CLI joins. (Deliberately not driven by
`joplin e2ee enable` — that command races its own settings flush on
process exit and intermittently no-ops with exit 0; the join path used
here is the reliable non-interactive flow, the same one the interop
tier proves.)

1. **The daemon enables E2EE and uploads ciphertext**: enable via lib
   (`generateMasterKeyAndEnableEncryption` — the call a stock client and
   `jonobones init` make); the app creates a secret note; the daemon
   syncs; assert via the server's API: `info.json` has `e2ee: true`, and
   the note item's raw content has `encryption_applied: 1` with neither
   title nor body in plaintext.
2. **The official CLI joins with the shared password and decrypts**:
   `config encryption.masterPassword`, then sync until the CLI's
   database observably has the note (`cliSyncUntil`), then
   `e2ee decrypt`; its database holds the plaintext title and body with
   `encryption_applied = 0`.
3. **The CLI's own writes are encrypted; the daemon decrypts them**: the
   CLI creates a secret note; sync until the item reaches the server;
   the server-side item is ciphertext (no plaintext leak); the daemon
   syncs (post-sync decryption runs); `/status` shows
   `e2ee.enabled: true`, `pendingDecryption: 0`; `/search` returns the
   plaintext body.

### server-resilience.test.ts — restarts, conflicts, outages

Runs a **spawned** daemon (the shipped binary) so it can genuinely
restart. Setup seeds one CLI note through the server into the daemon.

1. **Restart keeps the journal and checkpoint**: record all events; stop
   the daemon (exit code 0); start it again on the same profile and
   port; sync; the event list is unchanged — same count, same last id
   (no replay, no loss); an SSE reconnect with `Last-Event-ID: 0` still
   replays the full pre-restart journal.
2. **Concurrent edits → Joplin conflict semantics**: the CLI and the
   daemon edit the same note's body between syncs; CLI syncs first, then
   the daemon; `/conflicts` lists a conflict copy with
   `conflict_original_id` pointing at the note, and the original's body
   is the remote (CLI) version — remote wins, local edit preserved as
   the conflict copy.
3. **Server outage degrades honestly and recovers**: `docker stop` the
   server; `POST /sync` drives `/status` to `sync.state: 'error'` with a
   populated `lastResult` (the connectivity preflight at work); reads
   still serve from the local profile; `docker start` the server; the
   next sync completes and the data is intact.

### server-container.test.ts — the image as a user deploys it

Builds the repo's Dockerfile (`jonobones:e2e`) and needs only Docker —
no joplin CLI. The Joplin Server here is reachable **only inside a
docker network** with `APP_BASE_URL` set to its canonical in-network
URL, the shape of a real deployment (the server 404s any other origin,
`/api/ping` included, so readiness is polled from inside the network).

1. **Boots from env-only config and reports this build**: a container
   configured purely via `JONOBONES_*` env vars (token + target 9
   credentials), profile on a named volume, port published to
   `127.0.0.1`; `/v1/health` answers with `app: jonobones` and a
   `version` equal to this checkout's `package.json` — the image under
   test is provably this code; `/status` shows the env-provided target
   and the `/data` profile.
2. **Creates content over REST and syncs it to the server**: notebook +
   Unicode note via the API; after sync, `lastResult: 'ok'` and
   `pendingUpload: 0`.
3. **A second container from the same image pulls the knowledge base**:
   container B (own volume, own token) syncs and serves the note with
   the byte-identical body — two containerized clients through one
   server.
4. **`docker restart` loses nothing**: restart container A; the note
   still serves; the event journal has the same count and last id, and
   stays unchanged after a fresh sync (volume-backed profile, journal,
   and scan checkpoint all survived).

## Manual playground

The same stack, by hand — useful for poking at the daemon with real
Joplin tooling.

```sh
# 1. A local Joplin Server (admin@localhost / admin works immediately)
docker run -d --name jb-play -p 127.0.0.1:22300:22300 \
  -e APP_BASE_URL=http://127.0.0.1:22300 joplin/server:3.7.1
curl -fsS http://127.0.0.1:22300/api/ping   # → {"status":"ok",...}

# 2. A stock client: the official CLI, pointed at the server
joplin config sync.target 9
joplin config sync.9.path http://127.0.0.1:22300
joplin config sync.9.username admin@localhost
joplin config sync.9.password admin
joplin mkbook playground && joplin use playground && joplin mknote hello
joplin sync

# 3. jonobones on the same server
mkdir -p ~/.config/jonobones/play && cat > ~/.config/jonobones/play/config.json5 <<'EOF'
{
  api:  { port: 26637, bind: '127.0.0.1', token: 'play-token' },
  sync: {
    target: 'joplinServer',
    url: 'http://127.0.0.1:22300',
    username: 'admin@localhost',
    password: 'admin',
    interval: 300,
  },
}
EOF
chmod 600 ~/.config/jonobones/play/config.json5
jonobones start --profile play          # foreground — use its own terminal

# 4. The example app, watching changes over SSE (another terminal)
export JONOBONES_URL=http://127.0.0.1:26637 JONOBONES_TOKEN=play-token
node examples/jonobones-app.mjs watch &
NB=$(node examples/jonobones-app.mjs notebook add inbox \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
node examples/jonobones-app.mjs note add --title "from the app" --notebook "$NB"

# Now edit notes in the joplin CLI, run `joplin sync`, then
# `curl -X POST -H 'authorization: Bearer play-token' http://127.0.0.1:26637/v1/sync`
# — and watch the change events appear in the app's NDJSON stream.

# Teardown
docker rm -f jb-play
```

macOS note: the official CLI may route `sync.9.password` through the
system keychain (a prompt can appear). CI runs Linux, where the value
falls back to the profile database; this is a local-dev quirk only.
