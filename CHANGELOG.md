<!--
SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
SPDX-License-Identifier: CC-BY-4.0
-->

# Changelog

All notable changes to jonobones are recorded here. Each release entry has two
parts:

- **Highlights** — a 2-3 sentence "what's new" paragraph generated at release time by an Anthropic-API call (dev-tools' `generate-changelog`, run by the release workflow).
- **Categorized changes** — the release's pull requests grouped by Conventional Commit type, produced by dev-tools' `generate-changelog`; see [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md#commit--pr-title-convention-this-is-what-the-changelog-reads) for the exact grouping rule.

The release workflow on every tag push generates both, commits the new section here, and uses the same content as the GitHub Release body. A re-run after a partial failure makes no second model call: it reuses the section already committed instead of regenerating it.

<!--
  Keep-a-Changelog ordering: [Unreleased] at the top, then newest released
  version, then older versions. generate-changelog inserts new
  "## [vX.Y.Z] - YYYY-MM-DD" sections directly below [Unreleased].
  Don't remove the marker.
-->

## [Unreleased]

## [v0.1.8] - 2026-09-27

### Highlights

This release contains only internal changes to the project's CI workflows and contributor documentation, switching from squash merges and direct back-merges to merge commits and a back-merge pull request. There are no user-visible changes to the daemon itself.

### Maintenance

- Merge commits and the checked back-merge pull request (#14)

## [v0.1.7] - 2026-09-27

### Highlights

A recreated events journal no longer silently resumes clients at unrelated events: a fresh journal's ids are now seeded far above any earlier journal could have reached, so a stale cursor gets a reset over both SSE and polling, and event ids are large integers that no longer start at 1. Documentation has been corrected across the README, operations, API, testing and contributing guides to match the code, covering the profile root, container configuration routes, the default bind and token sources, the 1 MiB request body cap, and the restore endpoint's response. The rest is maintenance: dependency advisories fixable within existing version ranges were resolved, and the release workflow and changelog generation were rebuilt on shared tooling.

### Bug fixes

- Npm audit fix, the advisories fixable without a major upgrade (#11)
- A recreated events journal resets every client (#12)

### Docs

- Correct the documents before the release (#13)

### Maintenance

- Assemble the release workflow from the handbook's parts (#9)
- Generate the changelog with dev-tools' shared script (#10)

## [v0.1.6] - 2026-09-19

### Highlights

Fixes a daemon bootstrap regression where the Nextcloud, WebDAV and Dropbox sync targets failed to load against @joplin/lib 3.7.1, and re-pins both @joplin/lib and the CI joplin CLI to 3.7.1 to match the sync-target minimum version the current 3.7 client enforces. Documentation has been audited and corrected against the code, and the release workflow has been reassembled from the shared handbook parts; a new in-flight ideas document records an optimistic-concurrency proposal for contended writes.

### Bug fixes

- Re-pin @joplin/lib and the CI joplin CLI to 3.7.1, and fix sync-target loading for the new export shape (#6) (76ad260)

### Docs

- V0.1.5 [skip ci] (51531e6)
- Add in-flight_ideas.md with optimistic-concurrency proposal (#4) (ff27c39)
- Fix stale and wrong statements ahead of v0.1.6 (#8) (0832150)

## [v0.1.5] - 2026-06-25

### Highlights

This is a maintenance release with no user-facing code changes: the REST API reference in docs/api.md has been corrected and expanded to cover all nine error codes, success status conventions, pagination flags, relationship-list parameters, the 512 MB resource upload limit, and several endpoint-specific quirks, and a stale hardcoded version in the /health example was removed. The remaining work is internal — REUSE/AGPL formalization, handbook onboarding, changelog automation, and a CI pin bump to Node 24.

### Docs

- Close REST API reference gaps (error codes, status codes, limits) (#2) (97f3ae9)

