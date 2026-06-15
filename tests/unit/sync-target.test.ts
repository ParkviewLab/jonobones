// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { SyncConfigError, resolveSyncTarget } from '../../src/joplin/sync.js';

describe('resolveSyncTarget', () => {
  it('returns null when no target is configured', () => {
    expect(resolveSyncTarget({})).toBeNull();
    expect(resolveSyncTarget({ target: '' })).toBeNull();
    expect(resolveSyncTarget({ target: 'none' })).toBeNull();
  });

  it('rejects unknown targets', () => {
    expect(() => resolveSyncTarget({ target: 'gopher' })).toThrow(SyncConfigError);
  });

  it('maps filesystem', () => {
    const r = resolveSyncTarget({ target: 'filesystem', path: '/tmp/sync' })!;
    expect(r.spec.id).toBe(2);
    expect(r.settingValues).toEqual({ 'sync.2.path': '/tmp/sync' });
  });

  it('lists missing required keys', () => {
    expect(() => resolveSyncTarget({ target: 'webdav', url: 'https://x' })).toThrow(/username, password/);
    expect(() => resolveSyncTarget({ target: 'filesystem' })).toThrow(/path/);
  });

  it('maps webdav/joplinServer credentials onto sync.N.*', () => {
    const r = resolveSyncTarget({ target: 'joplinServer', url: 'https://js.example', username: 'u', password: 'p' })!;
    expect(r.spec.id).toBe(9);
    expect(r.settingValues).toEqual({
      'sync.9.path': 'https://js.example',
      'sync.9.username': 'u',
      'sync.9.password': 'p',
    });
  });

  it('maps s3 including forcePathStyle and optional region', () => {
    const r = resolveSyncTarget({
      target: 's3',
      bucket: 'b',
      url: 'https://s3.example',
      accessKey: 'ak',
      secretKey: 'sk',
      forcePathStyle: true,
    })!;
    expect(r.spec.id).toBe(8);
    expect(r.settingValues).toEqual({
      'sync.8.path': 'b',
      'sync.8.url': 'https://s3.example',
      'sync.8.username': 'ak',
      'sync.8.password': 'sk',
      'sync.8.forcePathStyle': true,
    });
  });

  it('maps dropbox auth blob', () => {
    const r = resolveSyncTarget({ target: 'dropbox', auth: 'token-blob' })!;
    expect(r.spec.id).toBe(7);
    expect(r.settingValues).toEqual({ 'sync.7.auth': 'token-blob' });
  });
});
