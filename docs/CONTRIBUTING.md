<!--
SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
SPDX-License-Identifier: CC-BY-4.0
-->

# Contributing

> The authoritative, org-wide version of these conventions is the
> [ParkviewLab handbook](https://github.com/ParkviewLab/handbook).

jonobones follows the ParkviewLab conventions. The essentials:

## Branch & PR flow

- Branch off **`develop`** into an ephemeral worktree named with a prefix:
  `feature-`, `bug-`/`fix-`, `doc-`, `test-`, `ops-`, `ci-`, `build-`, `release-`
  (hyphen, not slash). See the handbook's `branching.md`.
- Open a PR into **`develop`**. The repo is **squash-only**, so the merge button
  can only squash; **merging is the maintainer's action.**
- Releases are cut from **`main`** via the CLI (`git merge --no-ff develop`, then
  `git bump` + `git release`) — not a PR. See the handbook's `releases.md`.

## Commit / PR-title convention (this is what the changelog reads)

Because PRs are squash-merged, **the PR title becomes the commit subject**, and
the changelog is generated from it (via [git-cliff](https://git-cliff.org/) +
`cliff.toml`). Prefix every PR title with a [Conventional
Commit](https://www.conventionalcommits.org/) type:

| Prefix | CHANGELOG section | Notes |
|---|---|---|
| `feat:` | Features | user-visible |
| `fix:` | Bug fixes | user-visible |
| `perf:` | Performance | user-visible |
| `refactor:` | Refactor | |
| `docs:` | Docs | |
| `test:` | Tests | |
| `chore:` / `ci:` / `build:` / `style:` | _(dropped)_ | stays in git history, not surfaced |

A PR title without a recognised prefix is **silently dropped** from the
changelog. So: prefix it.

## Local checks before opening a PR

Run the same checks CI requires, so the PR is green on arrival:

```bash
npm ci
npm run typecheck
npm run lint
npm test                 # unit + integration (vitest)
uvx --from "reuse[charset-normalizer]" reuse lint
```

The `interop`, `docker`, and `e2e` CI tiers need Docker + the official Joplin
CLI/Server — see [`testing.md`](testing.md) to run them locally. A PR **can't be
merged until the required checks pass** (the CI matrix, interop, docker, e2e,
REUSE, and the version guard — see the handbook's `ci.md`).

## Versioning

The version lives in **`package.json` only** (read at runtime via `src/version.ts`);
never hard-code it elsewhere, and never type it on a `git tag` line — use
`git bump` / `git release` from
[`dev-tools`](https://github.com/ParkviewLab/dev-tools). See `releases.md`.

## Licensing

jonobones is **AGPL-3.0-or-later** — a derived work of Joplin (see
[`../LICENSING.md`](../LICENSING.md)). Every new file needs an SPDX header or a
`REUSE.toml` entry, or `reuse lint` breaks: code/config/CI → `AGPL-3.0-or-later`,
docs → `CC-BY-4.0`.

## AI contributors

Read [`northstar.md`](northstar.md) first, and follow the behavioural contract in
the handbook's `ai-collaboration.md` (notably: merging/tagging/releasing need an
explicit, per-action go-ahead).
