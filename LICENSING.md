<!--
SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
SPDX-License-Identifier: CC-BY-4.0
-->

# Licensing

Copyright © 2026 **Gary Frattarola**. `jonobones` follows the org's licensing
conventions (see the
[handbook's `licensing.md`](https://github.com/ParkviewLab/handbook/blob/main/docs/licensing.md)).

## Derived work of Joplin — AGPL is required, not chosen

jonobones is built on **[`@joplin/lib`](https://www.npmjs.com/package/@joplin/lib)** — the data and
synchronization engine of the [Joplin project](https://github.com/laurent22/joplin), by Laurent Cozic and
the Joplin contributors — which is licensed **AGPL-3.0-or-later**. jonobones is therefore a **derived work**
and is itself **AGPL-3.0-or-later**, matching upstream.

Because the combined work derives from AGPL-licensed Joplin, the AGPL terms are **required** — there is no
permissive or commercial alternative for this repository (unlike ParkviewLab's original-work AGPL projects).
jonobones imports `@joplin/lib` as an npm dependency; **no Joplin source is vendored** into this repository.
Full upstream attribution is in the README's "Credits & license" section.

## Per-bucket licensing

| Bucket | License | What |
|---|---|---|
| Source, tests, scripts, CI & build config — `src/**`, `tests/**`, `bin/**`, `scripts/**`, `.github/**`, `Dockerfile`, configs | `AGPL-3.0-or-later` | the program |
| Docs & repo meta — `README.md`, this file, `docs/**`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md` | `CC-BY-4.0` | the writing |

The split is encoded in [`REUSE.toml`](REUSE.toml) and per-file SPDX headers; the root
[`LICENSE`](LICENSE) holds the primary (AGPL-3.0-or-later) text for GitHub detection; full license texts are
in [`LICENSES/`](LICENSES/).

## REUSE

This repo is [REUSE](https://reuse.software/)-compliant; verify with:

```bash
uvx --from "reuse[charset-normalizer]" reuse lint
```
