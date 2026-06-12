# Testing

jonobones has four test tiers. Each one trusts the tier below it and
proves something the tier below cannot.

| Tier | Command | Needs | Proves |
|---|---|---|---|
| Unit | `npm test` (part of) | nothing | config precedence, pagination, lockfile, journal logic |
| Integration | `npm test` (part of) | nothing | every `/v1` endpoint over real HTTP, SSE mechanics, sync cycles against a filesystem target |
| Interop | `npm run test:interop` | official `joplin` CLI | byte-faithful round-trips with a stock client over a shared filesystem target, plaintext + E2EE |
| E2E | `npm run test:e2e` | Docker + official `joplin` CLI | the whole product story through a **real Joplin Server**: sync fidelity, SSE events, E2EE, restarts, conflicts, outages |

`npm test` never touches Docker — the e2e tier lives in its own vitest
config (`vitest.e2e.config.ts`) and only runs when asked. Interop and
e2e suites skip themselves (with a warning) when their prerequisites
are missing, so a bare `npm test` works on any machine.

## Prerequisites

- **Official joplin CLI** — either on `PATH` (`npm install -g joplin`)
  or pointed at directly:

  ```sh
  mkdir -p /tmp/joplin-cli && (cd /tmp/joplin-cli && npm install joplin)
  export JOPLIN_CLI_BIN=/tmp/joplin-cli/node_modules/.bin/joplin
  ```

- **Docker** (e2e only) — a running daemon. The suite pulls
  `joplin/server:3.7.1` on first use (override with the
  `JOPLIN_SERVER_IMAGE` env var; CI pins the same tag and caches the
  image as a tarball).

## The e2e tier in one paragraph

Each of the four suite files boots its own Joplin Server container
(`tests/e2e/server.ts`, labelled `jonobones-e2e`; orphans are swept by
the global setup) and drives three actors against it: the **official
joplin CLI** (a stock client), the **daemon** (in-process, or spawned
from `bin/jonobones.js` where a restart is being tested — `@joplin/lib`
is process-global, so a daemon can only be restarted as a process), and
the **example app** (`examples/jonobones-app.mjs`, a zero-dependency
REST/SSE client driven as a child process). The server runs with
`JOPLIN_IS_TESTING=1` — Joplin's own test switch — because every CLI
sync is a fresh process doing its own login, and the server's per-IP
brute-force limiter (10/min) would otherwise starve the suite. The
suites are `server-sync` (content fidelity both directions, trash/
restore, server-side permanent deletes, provisioning from a
hand-written `config.json5`), `server-events` (SSE `source:sync` and
`source:api`, `Last-Event-ID` replay), `server-e2ee` (join an encrypted
target, ciphertext at rest on the server), and `server-resilience`
(restart keeps the journal checkpoint, concurrent-edit conflicts,
server-outage error → recovery).

Two timing rules the suites encode (worth knowing before adding tests):

- **The baseline rule.** The daemon's first post-sync scan only
  snapshots known item ids — it emits no events, by design. Every suite
  runs one baseline sync in `beforeAll`; event assertions only make
  sense after it, and a remote *delete* can only be detected for an
  item that was synced and scanned in first.
- **Idle means done.** `/status` reports `idle` only after the
  post-sync event scan, decryption, and resource downloads finish, so
  "POST `/sync`, poll until idle" needs no extra settling time.

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
