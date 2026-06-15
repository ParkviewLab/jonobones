// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const APP_NAME = 'jonobones';
export const VERSION = pkg.version;

// Bumped only on breaking API change, together with the /v1 URL prefix.
export const API_VERSION = 1;
