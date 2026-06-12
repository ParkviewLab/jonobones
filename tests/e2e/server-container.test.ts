// E2E: the container image as a user deploys it. Builds the local
// Dockerfile, then drives the result like a real deployment: env-only
// configuration, the profile on a named volume, a Joplin Server reachable
// only by its canonical in-network URL, a second container from the same
// image as the second client, and a docker restart that must lose nothing.
//
// No joplin CLI here — cross-client fidelity with the official client is
// the other suites' job; this one proves the shipped image. Needs only
// docker, so it runs even where the CLI is absent.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, freePort, type DaemonClient } from './harness.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  docker,
  hasDocker,
  startJoplinServerOnNetwork,
  type NetworkedJoplinServerHandle,
} from './server.js';

const DOCKER = hasDocker();
const APP_IMAGE = 'jonobones:e2e';
const TOKEN_A = 'e2e-container-a-token';
const TOKEN_B = 'e2e-container-b-token';
const CONTAINER_BODY = 'born in a container — déjà vu, 草書, 🦴';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const pkgVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

const suffix = randomBytes(3).toString('hex');
let network: string;
let server: NetworkedJoplinServerHandle;
let nameA: string;
let nameB: string | undefined;
let portA: number;
let clientA: DaemonClient;
let noteId: string;

async function waitHealth(port: number, containerName: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      let logs = '';
      try {
        logs = docker('logs', '--tail', '30', containerName);
      } catch {
        /* container gone */
      }
      throw new Error(`container ${containerName} never served /v1/health\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function startAppContainer(name: string, port: number, volume: string, token: string): Promise<void> {
  docker('volume', 'create', '--label', 'jonobones-e2e', volume);
  docker(
    'run',
    '-d',
    '--label',
    'jonobones-e2e',
    '--name',
    name,
    '--network',
    network,
    '-p',
    `127.0.0.1:${port}:26637`,
    '-v',
    `${volume}:/data`,
    '-e',
    `JONOBONES_API_TOKEN=${token}`,
    '-e',
    'JONOBONES_SYNC_TARGET=joplinServer',
    '-e',
    `JONOBONES_SYNC_URL=${server.url}`,
    '-e',
    `JONOBONES_SYNC_USERNAME=${ADMIN_EMAIL}`,
    '-e',
    `JONOBONES_SYNC_PASSWORD=${ADMIN_PASSWORD}`,
    '-e',
    'JONOBONES_SYNC_INTERVAL=0',
    APP_IMAGE,
  );
  await waitHealth(port, name);
}

describe.skipIf(!DOCKER)('e2e: the container image', () => {
  beforeAll(async () => {
    // Build the image from this checkout — the suite tests THIS code.
    execFileSync('docker', ['build', '-t', APP_IMAGE, repoRoot], { encoding: 'utf8', timeout: 600_000 });

    network = `jb-e2e-net-${suffix}`;
    docker('network', 'create', '--label', 'jonobones-e2e', network);
    server = await startJoplinServerOnNetwork(network, APP_IMAGE);

    nameA = `jb-e2e-app-a-${suffix}`;
    portA = await freePort();
    await startAppContainer(nameA, portA, `jb-e2e-vol-a-${suffix}`, TOKEN_A);
    clientA = createClient(`http://127.0.0.1:${portA}/v1`, TOKEN_A);
  }, 600_000);

  afterAll(async () => {
    for (const name of [nameA, nameB]) {
      if (!name) continue;
      try {
        docker('rm', '-f', name);
      } catch {
        /* already gone */
      }
    }
    await server?.stop();
    for (const args of [
      ['volume', 'rm', `jb-e2e-vol-a-${suffix}`, `jb-e2e-vol-b-${suffix}`],
      ['network', 'rm', network],
    ]) {
      try {
        docker(...(args as string[]));
      } catch {
        /* never created, or already swept */
      }
    }
  });

  it('boots from env-only config and reports this build', async () => {
    const health = (await (await fetch(`http://127.0.0.1:${portA}/v1/health`)).json()) as Record<string, unknown>;
    expect(health.app).toBe('jonobones');
    expect(health.apiVersion).toBe(1);
    // The image was built from this checkout; the daemon inside must agree.
    expect(health.version).toBe(pkgVersion);

    const status = await clientA.http('GET', '/status');
    expect(status.body.sync.target).toBe('joplinServer');
    expect(status.body.profile.path).toBe('/data/joplin');
  });

  it('creates content over REST and syncs it to the server', async () => {
    await clientA.syncAndWaitIdle(); // converge with the boot sync

    const nb = (await clientA.http('POST', '/notebooks', { title: 'container-book' })).body;
    noteId = (
      await clientA.http('POST', '/notes', { title: 'container-note', body: CONTAINER_BODY, parent_id: nb.id })
    ).body.id;
    await clientA.syncAndWaitIdle();

    const status = await clientA.http('GET', '/status');
    expect(status.body.sync.lastResult).toBe('ok');
    expect(status.body.sync.pendingUpload).toBe(0);
  });

  it('a second container from the same image pulls the knowledge base', { timeout: 240_000 }, async () => {
    nameB = `jb-e2e-app-b-${suffix}`;
    const portB = await freePort();
    await startAppContainer(nameB, portB, `jb-e2e-vol-b-${suffix}`, TOKEN_B);
    const clientB = createClient(`http://127.0.0.1:${portB}/v1`, TOKEN_B);

    await clientB.syncAndWaitIdle();
    const note = await clientB.http('GET', `/notes/${noteId}?fields=id,title,body`);
    expect(note.status).toBe(200);
    expect(note.body.title).toBe('container-note');
    expect(note.body.body).toBe(CONTAINER_BODY);
  });

  it('docker restart loses neither the profile nor the event journal', async () => {
    const before = await clientA.allEvents();
    expect(before.length).toBeGreaterThan(0);
    const lastId = before[before.length - 1]!.id;

    docker('restart', nameA);
    await waitHealth(portA, nameA);

    expect((await clientA.http('GET', `/notes/${noteId}?fields=id,title`)).status).toBe(200);
    await clientA.syncAndWaitIdle(); // restart's boot sync; nothing changed remotely
    const after = await clientA.allEvents();
    expect(after.length).toBe(before.length);
    expect(after[after.length - 1]!.id).toBe(lastId);
  });
});

if (!DOCKER) {
  console.warn('container e2e suite skipped: needs a running docker daemon');
}
