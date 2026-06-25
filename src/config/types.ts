// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ApiConfig {
  port: number;
  bind: string;
  token?: string;
}

// Target-specific keys (path, username, password, url, ...) live flat in the
// sync section; only target and interval are universal.
export interface SyncConfig {
  target: string;
  interval: number;
  [key: string]: unknown;
}

export interface E2eeConfig {
  masterPassword?: string;
}

export interface EventsConfig {
  retentionDays: number;
}

export interface Config {
  api: ApiConfig;
  sync: SyncConfig;
  e2ee: E2eeConfig;
  events: EventsConfig;
}

export interface CliFlags {
  profile?: string;
  port?: number;
  bind?: string;
  token?: string;
}

export class ConfigError extends Error {}
