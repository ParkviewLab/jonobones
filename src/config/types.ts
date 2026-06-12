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

export interface Config {
  api: ApiConfig;
  sync: SyncConfig;
  e2ee: E2eeConfig;
}

export interface CliFlags {
  profile?: string;
  port?: number;
  bind?: string;
  token?: string;
}

export class ConfigError extends Error {}
