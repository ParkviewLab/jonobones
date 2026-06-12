import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import { defaultConfig } from './defaults.js';
import { ConfigError, type CliFlags, type Config } from './types.js';

export const CONFIG_FILENAME = 'config.json5';

type Section = 'api' | 'sync' | 'e2ee' | 'events';
const SECTIONS: Section[] = ['api', 'sync', 'e2ee', 'events'];

interface SectionOverlay {
  [key: string]: unknown;
}

type Overlay = Partial<Record<Section, SectionOverlay>>;

function coerce(raw: string): unknown {
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

// JONOBONES_<SECTION>_<KEY_PARTS...> → <section>.<keyParts camelCased>
// e.g. JONOBONES_API_PORT → api.port, JONOBONES_E2EE_MASTER_PASSWORD →
// e2ee.masterPassword. JONOBONES_E2EE_PASSWORD is an explicit alias for
// e2ee.masterPassword (the documented short form).
export function envOverlay(env: NodeJS.ProcessEnv): Overlay {
  const overlay: Overlay = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith('JONOBONES_')) continue;
    const parts = name.slice('JONOBONES_'.length).split('_').filter((p) => p !== '');
    if (parts.length < 2) continue;
    const section = parts[0]!.toLowerCase() as Section;
    if (!SECTIONS.includes(section)) continue;

    let key = parts
      .slice(1)
      .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0) + p.slice(1).toLowerCase()))
      .join('');
    if (section === 'e2ee' && key === 'password') key = 'masterPassword';

    (overlay[section] ??= {})[key] = coerce(value);
  }
  return overlay;
}

export function flagsOverlay(flags: CliFlags): Overlay {
  const api: SectionOverlay = {};
  if (flags.port !== undefined) api.port = flags.port;
  if (flags.bind !== undefined) api.bind = flags.bind;
  if (flags.token !== undefined) api.token = flags.token;
  return Object.keys(api).length ? { api } : {};
}

function readConfigFile(profileDir: string): Overlay {
  const path = join(profileDir, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (error) {
    throw new ConfigError(`invalid JSON5 in ${path}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`invalid config in ${path}: expected a top-level object`);
  }
  const overlay: Overlay = {};
  for (const section of SECTIONS) {
    const value = (parsed as Record<string, unknown>)[section];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConfigError(`invalid config in ${path}: "${section}" must be an object`);
    }
    overlay[section] = value as SectionOverlay;
  }
  return overlay;
}

function mergeInto(config: Config, overlay: Overlay): void {
  for (const section of SECTIONS) {
    const values = overlay[section];
    if (!values) continue;
    Object.assign(config[section], values);
  }
}

export interface LoadConfigOptions {
  profileDir: string;
  env?: NodeJS.ProcessEnv;
  flags?: CliFlags;
}

// Precedence: flags > env > config file > defaults.
export function loadConfig({ profileDir, env = process.env, flags = {} }: LoadConfigOptions): Config {
  const config = defaultConfig();
  mergeInto(config, readConfigFile(profileDir));
  mergeInto(config, envOverlay(env));
  mergeInto(config, flagsOverlay(flags));
  return config;
}

export function validateConfigForServe(config: Config): void {
  const { port, bind, token } = config.api;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`api.port must be an integer in 1-65535, got ${JSON.stringify(port)}`);
  }
  if (typeof bind !== 'string' || bind.trim() === '') {
    throw new ConfigError('api.bind must be a non-empty string');
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ConfigError(
      'no API token configured — run `jonobones init`, or set api.token in config.json5 or JONOBONES_API_TOKEN',
    );
  }
}
