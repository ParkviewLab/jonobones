<!--
SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
SPDX-License-Identifier: CC-BY-4.0
-->

# Changelog

All notable changes to jonobones are recorded here. Each release entry has two
parts:

- **Highlights** — a 2-3 sentence "what's new" paragraph generated at release
  time by an Anthropic-API call (see `scripts/generate_changelog.py`).
- **Categorized changes** — a list of merged commits since the previous tag,
  grouped by [Conventional Commit](https://www.conventionalcommits.org/) prefix,
  produced by [git-cliff](https://git-cliff.org/) using `cliff.toml`.

The release workflow on every tag push regenerates both, commits the new section
here, and uses the same content as the GitHub Release body.

<!--
  Keep-a-Changelog ordering: [Unreleased] at the top, then newest released
  version, then older versions. generate_changelog.py inserts new
  "## [vX.Y.Z] - YYYY-MM-DD" sections directly below [Unreleased].
  Don't remove the marker.
-->

## [Unreleased]

## [v0.1.5] - 2026-06-25

### Highlights

This is a maintenance release with no user-facing code changes: the REST API reference in docs/api.md has been corrected and expanded to cover all nine error codes, success status conventions, pagination flags, relationship-list parameters, the 512 MB resource upload limit, and several endpoint-specific quirks, and a stale hardcoded version in the /health example was removed. The remaining work is internal — REUSE/AGPL formalization, handbook onboarding, changelog automation, and a CI pin bump to Node 24.

### Docs

- Close REST API reference gaps (error codes, status codes, limits) (#2) (97f3ae9)

