#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { main } from '../dist/cli/index.js';

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
