# jonobones

**A headless, Joplin-sync-compatible knowledge daemon.**

jonobones owns a private [Joplin](https://joplinapp.org)-format knowledge
base (notes, notebooks, tags, resources), keeps it synchronized with any
Joplin sync target — Joplin Server, Joplin Cloud, filesystem, WebDAV /
Nextcloud, Dropbox, OneDrive, S3 — and serves it to local applications over
a localhost REST API.

Use it when an application needs a Joplin-synced knowledge base as its
storage layer, without embedding Joplin or requiring Joplin Desktop to run.

```
┌─────────────┐   HTTP /v1    ┌────────────┐   Joplin sync    ┌─────────────┐
│ your client ├──────────────►│ jonobones  │◄────────────────►│ sync target │
└─────────────┘  127.0.0.1    │  daemon    │   (any kind)     └─────────────┘
                              └────────────┘
```

- **Clients speak HTTP only.** The SQLite database, resource files, sync
  metadata, and encryption keys are private to the daemon.
- **The profile stays 100% a stock Joplin client profile.** Anything jonobones
  stores for itself lives outside it. Other Joplin clients keep working
  against the same sync target, unaware anything changed.
- **Data plane is the REST API; control plane is the CLI.** Configuration and
  secrets are never readable or writable over HTTP.

## Quickstart

```sh
npm install -g jonobones

jonobones init       # interactive: pick a sync target, run the first sync,
                     # set up the API token — populates the knowledge base
jonobones start      # serve http://127.0.0.1:26637/v1 in the foreground

curl http://127.0.0.1:26637/v1/health
# {"app":"jonobones","version":"…","apiVersion":1}
```

All endpoints except `GET /health` require the API token, either as
`Authorization: Bearer <token>` or `?token=<token>` (the latter exists for
`EventSource`/SSE clients). The token, port, and profile path are written to
`lock.json` in the profile directory (mode 0600) for local discovery.

Run it under your service manager with `jonobones service install`
(launchd on macOS, systemd on Linux), or in Docker — every config key is
overridable via `JONOBONES_*` environment variables.

## Smoke test

With the daemon running and a token in hand:

```sh
TOKEN=$(node -e "console.log(require(process.env.HOME+'/.config/jonobones/default/lock.json').token)")

curl -s http://127.0.0.1:26637/v1/health
curl -sN "http://127.0.0.1:26637/v1/events?token=$TOKEN" &
# now edit a note in any other Joplin client on the same sync target and
# watch the change event arrive after the next sync cycle.
```

## Configuration

A profile lives at `~/.config/jonobones/<name>/` (default profile:
`default`). Its `config.json5` is canonical; environment variables and CLI
flags override it (flags > env > config > defaults):

```json5
{
  api:  { port: 26637, bind: '127.0.0.1', token: '…' },
  sync: { target: 'filesystem', interval: 300, path: '/path/to/sync-dir' },
  e2ee: { masterPassword: '…' },   // only if the target is encrypted
}
```

Environment names follow `JONOBONES_<SECTION>_<KEY>`: `JONOBONES_API_PORT`,
`JONOBONES_SYNC_PASSWORD`, `JONOBONES_E2EE_PASSWORD`, …

A note on secrets: the config file is `0600` in a `0700` profile directory.
Joplin's end-to-end encryption protects the *sync target* copies — the local
database is plaintext by design, in jonobones exactly as in Joplin Desktop.
Full-disk encryption is the real wall; OS keychain support may come later.

## Credits & license

jonobones is built on **[`@joplin/lib`](https://www.npmjs.com/package/@joplin/lib)**,
the data and synchronization engine developed by the
[Joplin project](https://github.com/laurent22/joplin) — the same engine the
Joplin apps themselves use. All credit for the sync protocol, data model, and
encryption design belongs to Laurent Cozic and the Joplin contributors.

jonobones is an independent project. It is **not** affiliated with, endorsed
by, or part of the Joplin project; "Joplin" is used here only to describe
compatibility ("Joplin-sync-compatible").

Licensed [AGPL-3.0-or-later](LICENSE), matching `@joplin/lib` upstream.
