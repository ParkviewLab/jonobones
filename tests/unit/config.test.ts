import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, validateConfigForServe } from '../../src/config/load.js';
import { resolveProfileDir, profilesRoot } from '../../src/config/profile.js';
import { ConfigError } from '../../src/config/types.js';

const tempDirs: string[] = [];
function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jonobones-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('loadConfig precedence', () => {
  it('returns defaults when nothing else is present', () => {
    const config = loadConfig({ profileDir: tempProfile(), env: {} });
    expect(config.api.port).toBe(26637);
    expect(config.api.bind).toBe('127.0.0.1');
    expect(config.sync.target).toBe('filesystem');
    expect(config.sync.interval).toBe(300);
    expect(config.api.token).toBeUndefined();
  });

  it('reads JSON5 (comments, trailing commas) and overrides defaults', () => {
    const dir = tempProfile();
    writeFileSync(
      join(dir, 'config.json5'),
      `{
        // a comment
        api: { port: 31337, token: 'file-token', },
        sync: { target: 'filesystem', path: '/tmp/sync', },
      }`,
    );
    const config = loadConfig({ profileDir: dir, env: {} });
    expect(config.api.port).toBe(31337);
    expect(config.api.token).toBe('file-token');
    expect(config.api.bind).toBe('127.0.0.1'); // default survives partial section
    expect(config.sync.path).toBe('/tmp/sync');
  });

  it('env overrides file; flags override env', () => {
    const dir = tempProfile();
    writeFileSync(join(dir, 'config.json5'), `{ api: { port: 1111, token: 'file-token' } }`);
    const env = { JONOBONES_API_PORT: '2222', JONOBONES_API_TOKEN: 'env-token' };

    const envOnly = loadConfig({ profileDir: dir, env });
    expect(envOnly.api.port).toBe(2222);
    expect(envOnly.api.token).toBe('env-token');

    const withFlags = loadConfig({ profileDir: dir, env, flags: { port: 3333, token: 'flag-token' } });
    expect(withFlags.api.port).toBe(3333);
    expect(withFlags.api.token).toBe('flag-token');
  });

  it('maps env names: snake segments to camelCase, e2ee password alias, coercion', () => {
    const config = loadConfig({
      profileDir: tempProfile(),
      env: {
        JONOBONES_SYNC_INTERVAL: '60',
        JONOBONES_SYNC_PASSWORD: 'sync-secret',
        JONOBONES_E2EE_PASSWORD: 'master-secret',
        JONOBONES_E2EE_MASTER_PASSWORD_HINT: 'a hint', // multiword camelCase
        JONOBONES_API_BIND: '0.0.0.0',
        JONOBONES_UNRELATED_THING: 'ignored',
        UNRELATED: 'ignored',
      },
    });
    expect(config.sync.interval).toBe(60);
    expect(config.sync.password).toBe('sync-secret');
    expect(config.e2ee.masterPassword).toBe('master-secret');
    expect((config.e2ee as Record<string, unknown>).masterPasswordHint).toBe('a hint');
    expect(config.api.bind).toBe('0.0.0.0');
    expect((config as unknown as Record<string, unknown>).unrelated).toBeUndefined();
  });

  it('rejects malformed config files', () => {
    const dir = tempProfile();
    writeFileSync(join(dir, 'config.json5'), '{ api: [1,2,3] }');
    expect(() => loadConfig({ profileDir: dir, env: {} })).toThrow(ConfigError);
  });
});

describe('validateConfigForServe', () => {
  it('requires a token', () => {
    const config = loadConfig({ profileDir: tempProfile(), env: {} });
    expect(() => validateConfigForServe(config)).toThrow(/token/);
    config.api.token = 'something';
    expect(() => validateConfigForServe(config)).not.toThrow();
  });

  it('rejects out-of-range ports', () => {
    const config = loadConfig({ profileDir: tempProfile(), env: { JONOBONES_API_TOKEN: 't' } });
    config.api.port = 0;
    expect(() => validateConfigForServe(config)).toThrow(/port/);
  });
});

describe('resolveProfileDir', () => {
  it('defaults to <root>/default and treats bare names as names', () => {
    const env = { XDG_CONFIG_HOME: '/x/cfg' };
    expect(profilesRoot(env)).toBe('/x/cfg/jonobones');
    expect(resolveProfileDir(undefined, env)).toBe('/x/cfg/jonobones/default');
    expect(resolveProfileDir('work', env)).toBe('/x/cfg/jonobones/work');
  });

  it('treats separators and dots as paths', () => {
    const env = {};
    expect(resolveProfileDir('/abs/path', env)).toBe('/abs/path');
    expect(resolveProfileDir('./rel', env)).toBe(join(process.cwd(), 'rel'));
  });
});
