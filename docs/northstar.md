# jonobones — northstar

## Intent

jonobones exists to do two things at once, and both matter:

1. **Liberate Joplin-synced knowledge for any local application.**
   A knowledge base that lives in the Joplin sync ecosystem should be
   usable as a storage layer by *any* program — a UI, a script, an
   agent — without that program embedding Joplin, running Joplin
   Desktop, or understanding sync, encryption, or SQLite. jonobones is
   the one process that knows those things, and it serves the result
   over a boring localhost REST API.

2. **Be a perfect citizen of the Joplin sync ecosystem.**
   To every other client on the sync target, a profile managed by
   jonobones is indistinguishable from one managed by a stock Joplin
   app. Notes, notebooks, tags, resources, links, `user_data`,
   encryption, conflict behavior — all of it round-trips faithfully,
   forever.

The two intents pull against each other in a useful way: the first
wants to expose more, more conveniently; the second forbids any
convenience that would bend the data model or the sync contract. When
they conflict, **fidelity wins** — a less convenient API is acceptable;
a profile another Joplin client can't trust is not.

## Axioms

1. **Sync fidelity is the prime axiom.** The managed profile stays a
   100% stock Joplin client profile: every write goes through
   `@joplin/lib`'s model layer (Joplin keeps its bookkeeping in
   application code, not DB triggers — raw SQL writes corrupt sync
   state). Anything jonobones owns for itself — event journal, config,
   lockfile — lives *outside* the Joplin profile, never as extra
   tables or files inside it.

2. **Clients speak HTTP only.** No client ever touches the SQLite
   database, the resource files, sync metadata, or encryption keys.
   If a capability isn't in the API, the answer is to extend the API,
   not to peek behind it.

3. **Data plane and control plane are separate.** The REST API serves
   and mutates *knowledge* (notes, notebooks, tags, resources, their
   `user_data`). Provisioning — sync credentials, encryption
   passwords, tokens, config — is the CLI's job. No config mutation
   and no secrets over HTTP, ever. (`POST /sync` is operational, not
   configuration, and is allowed.)

4. **Derive, don't fork.** jonobones depends on `@joplin/lib`, pinned
   to an exact version, quarantined behind one directory
   (`src/joplin/` — the anti-corruption layer). No copied Joplin
   source, no patched engine. When upstream moves, jonobones re-pins
   and re-verifies; the interop suite is the gate.

5. **Built for no particular client.** jonobones knows nothing about
   the applications that use it. Client-specific conventions (e.g.
   `user_data` namespaces) are the client's business; nothing in
   jonobones' code, API, or docs names or favors one.

## What jonobones is not

- Not a Joplin app, fork, or replacement — and not affiliated with or
  endorsed by the Joplin project. "Joplin" appears here only to
  describe compatibility.
- Not a multi-user server. One daemon, one profile, one machine,
  localhost only. (Joplin Server already exists.)
- Not a sync service. It is a *client* of sync targets, never a
  target itself.
