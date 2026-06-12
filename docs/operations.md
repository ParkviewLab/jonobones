# Operating jonobones

## Install

```sh
npm install -g jonobones        # Node >= 24
```

From a checkout: `npm ci && npm run build`, then run `bin/jonobones.js`.

Releases are published automatically on every version tag: npm via
trusted publishing (OIDC) and `ghcr.io/parkviewlab/jonobones` via the
repo's own token — no long-lived credentials in CI.

## Provision a profile

```sh
jonobones init [--profile <name|path>]
```

The wizard, in order: creates the profile dir (0700) → picks a sync target
and collects credentials → **tests connectivity** → runs the **first sync**
(this *is* the import — there is no separate import step) → detects
end-to-end encryption on the target and verifies the master password →
generates the API token and writes `config.json5` (0600).

Profiles live at `~/.config/jonobones/<name>/` (or any path you pass).
One daemon per profile; a second `start` prints "already running" and
exits 0.

## Run

```sh
jonobones start [--profile …]     # foreground
jonobones status                  # daemon + sync + e2ee status
jonobones sync                    # trigger a cycle now
jonobones stop
```

Daemonization belongs to the service manager:

```sh
jonobones service install [--profile …]    # launchd agent (macOS) or
jonobones service uninstall                # systemd --user unit (Linux)
```

launchd logs land in `<profile>/logs/`; systemd logs in
`journalctl --user -u jonobones-<profile>`.

### Docker

Released images are published to GitHub Container Registry on every
version tag (`linux/amd64` + `linux/arm64`):

```sh
docker run -d -v jonobones-data:/data \
  -p 127.0.0.1:26637:26637 \
  -e JONOBONES_API_TOKEN=$(openssl rand -hex 24) \
  -e JONOBONES_SYNC_TARGET=joplinServer \
  -e JONOBONES_SYNC_URL=https://your-server \
  -e JONOBONES_SYNC_USERNAME=you \
  -e JONOBONES_SYNC_PASSWORD=… \
  ghcr.io/parkviewlab/jonobones:latest
```

Tags: `latest`, `X.Y.Z`, `X.Y`. Building locally instead:
`docker build -t jonobones .`

Inside the container the daemon binds `0.0.0.0`; publish the port back to
`127.0.0.1` on the host (as above) to keep the localhost-only model.

## Configuration

`<profile>/config.json5` is canonical; precedence is
**flags > `JONOBONES_*` env > config file > defaults**.

```json5
{
  api:  { port: 26637, bind: '127.0.0.1', token: '…' },
  sync: { target: 'filesystem', interval: 300, path: '/path/to/dir' },
  e2ee: { masterPassword: '…' },        // only for encrypted targets
  events: { retentionDays: 30 },
}
```

Env names: `JONOBONES_<SECTION>_<KEY>` (snake → camelCase per segment):
`JONOBONES_API_PORT`, `JONOBONES_API_TOKEN`, `JONOBONES_SYNC_TARGET`,
`JONOBONES_SYNC_INTERVAL`, `JONOBONES_SYNC_PASSWORD`,
`JONOBONES_E2EE_PASSWORD` (alias for `e2ee.masterPassword`),
`JONOBONES_EVENTS_RETENTION_DAYS`, …

### Sync targets and their keys

| `sync.target` | required keys | optional |
| --- | --- | --- |
| `filesystem` | `path` | |
| `webdav` / `nextcloud` | `url`, `username`, `password` | |
| `joplinServer` | `url`, `username`, `password` | |
| `joplinCloud` | `username`, `password` | `url`, `userContentUrl` |
| `s3` | `bucket`, `url`, `accessKey`, `secretKey` | `region`, `forcePathStyle` |
| `dropbox` | `auth` (use the wizard's paste-code flow) | |
| `onedrive` | `auth` — not yet supported by the wizard | |
| `none` / unset | API-only daemon, no sync | |

`interval` is seconds between cycles; `0` disables the timer (`POST /sync`
still works).

## Security model (honest version)

- The API binds loopback and every endpoint except `/health` needs the
  bearer token. Local processes that can read your files can read the
  token; the boundary is *your user account*, not the network.
- Joplin's E2EE protects the **sync-target copies**. The local
  `database.sqlite` is plaintext **by design** — in jonobones exactly as
  in Joplin Desktop. Full-disk encryption is the real wall for data at
  rest; that is why storing the master password in the 0600 config is not
  the weak link it may look like (the plaintext DB sits right next to it).
- Secrets never travel over the API. Discovery (`lock.json`) is 0600.

## Backup

Back up the **profile directory** (config, events journal, and the
`joplin/` profile) while the daemon is stopped — or rely on the sync
target as the canonical replica and treat profiles as disposable: a fresh
`jonobones init` against the same target rebuilds everything.

## Troubleshooting

- **"already running on port N"** — that's the per-profile lock working; a
  stale lock from a crashed process is taken over automatically.
- **`GET /resources/{id}/file` → 404 "not yet downloaded"** — metadata
  synced before the blob; the fetcher downloads after each cycle, retry
  shortly.
- **Encrypted gibberish / `e2ee.pendingDecryption` > 0** — the daemon lacks
  (or has the wrong) `e2ee.masterPassword`; fix the config and restart, the
  next cycle decrypts.
- **`sync.state: "error"`** — `lastResult` carries the message;
  `jonobones status` shows it.
- **Events `reset`** — your cursor predates the retention window; re-sync
  state via REST per the snapshot-race recipe in [api.md](api.md#events).
- The journal (`events.sqlite`) is jonobones' own and can be deleted while
  stopped — clients will get a `reset`; the knowledge base is untouched.
