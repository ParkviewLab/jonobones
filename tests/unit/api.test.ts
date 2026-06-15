// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

const TOKEN = 'test-token-123';

let app: FastifyInstance | null = null;

function build(): FastifyInstance {
  const config = defaultConfig();
  config.api.token = TOKEN;
  app = buildServer(config);
  return app;
}

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

describe('GET /v1/health', () => {
  it('responds without auth with app/version/apiVersion', async () => {
    const res = await build().inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.app).toBe('jonobones');
    expect(body.apiVersion).toBe(1);
    expect(typeof body.version).toBe('string');
  });
});

describe('auth hook', () => {
  it('rejects missing token with a 401 envelope', async () => {
    const res = await build().inject({ method: 'GET', url: '/v1/anything' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('rejects a wrong bearer token', async () => {
    const res = await build().inject({
      method: 'GET',
      url: '/v1/anything',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts Authorization: Bearer and falls through to 404 envelope', async () => {
    const res = await build().inject({
      method: 'GET',
      url: '/v1/no-such-route',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('accepts ?token=', async () => {
    const res = await build().inject({ method: 'GET', url: `/v1/no-such-route?token=${TOKEN}` });
    expect(res.statusCode).toBe(404); // authenticated, route simply absent
  });
});
