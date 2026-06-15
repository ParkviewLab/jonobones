// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Config } from './types.js';

export function defaultConfig(): Config {
  return {
    api: {
      // "BONES" on a phone keypad. Deliberately far from Joplin's own 41184.
      port: 26637,
      bind: '127.0.0.1',
    },
    sync: {
      // 'none' = API-only until provisioned; `jonobones init` writes the
      // real target. A bare `start` (or the Docker smoke) must come up.
      target: 'none',
      interval: 300,
    },
    e2ee: {},
    events: {
      retentionDays: 30,
    },
  };
}
