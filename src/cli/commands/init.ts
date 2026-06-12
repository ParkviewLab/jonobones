import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILENAME } from '../../config/load.js';
import { resolveProfileDir } from '../../config/profile.js';
import type { CliFlags } from '../../config/types.js';
import { bootstrapJoplin, type JoplinContext } from '../../joplin/bootstrap.js';
import {
  SYNC_TARGETS,
  SyncRunner,
  applyE2eePassword,
  applySyncTarget,
  resolveSyncTarget,
} from '../../joplin/sync.js';
import { findRunningDaemon } from '../daemon-client.js';
import { Prompter, StdinEndedError } from '../prompts.js';

const WIZARD_TARGETS = [
  { key: 'filesystem', label: 'Filesystem (a local or mounted directory)' },
  { key: 'webdav', label: 'WebDAV' },
  { key: 'nextcloud', label: 'Nextcloud' },
  { key: 'joplinServer', label: 'Joplin Server' },
  { key: 'joplinCloud', label: 'Joplin Cloud' },
  { key: 's3', label: 'S3 (or S3-compatible)' },
  { key: 'dropbox', label: 'Dropbox (paste-code OAuth)' },
];

function expandPath(input: string): string {
  if (input.startsWith('~/') || input === '~') return resolve(join(homedir(), input.slice(1)));
  return isAbsolute(input) ? input : resolve(input);
}

async function collectTargetParams(
  prompter: Prompter,
  ctx: JoplinContext,
  targetKey: string,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { target: targetKey };

  if (targetKey === 'filesystem') {
    const path = expandPath(await prompter.askRequired('sync directory path'));
    mkdirSync(path, { recursive: true });
    params.path = path;
  } else if (targetKey === 'webdav' || targetKey === 'nextcloud' || targetKey === 'joplinServer') {
    params.url = await prompter.askRequired('server URL');
    params.username = await prompter.askRequired('username');
    params.password = await prompter.askHidden('password');
  } else if (targetKey === 'joplinCloud') {
    params.username = await prompter.askRequired('Joplin Cloud email');
    params.password = await prompter.askHidden('password');
  } else if (targetKey === 's3') {
    params.bucket = await prompter.askRequired('bucket name');
    params.url = await prompter.askRequired('endpoint URL', 'https://s3.amazonaws.com/');
    const region = await prompter.ask('region (empty for default)', '');
    if (region) params.region = region;
    params.accessKey = await prompter.askRequired('access key id');
    params.secretKey = await prompter.askHidden('secret access key');
    params.forcePathStyle = await prompter.confirm('force path-style addressing?', false);
  } else if (targetKey === 'dropbox') {
    // lib's terminal paste-code flow, same as the official CLI.
    /* eslint-disable @typescript-eslint/no-explicit-any -- lib boundary */
    const TargetClass = ctx.lib.SyncTargetRegistry.classById(SYNC_TARGETS.dropbox!.id);
    const target: any = new TargetClass(ctx.lib.database);
    const api: any = await target.api();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    console.log('\nOpen this URL in any browser, authorize Joplin, and paste the code back:\n');
    console.log(`  ${api.loginUrl()}\n`);
    const code = await prompter.askRequired('authorization code');
    await api.execAuthToken(code);
    params.auth = api.authToken();
  }

  return params;
}

export async function commandInit(flags: CliFlags): Promise<void> {
  const profileDir = resolveProfileDir(flags.profile);

  if (findRunningDaemon(profileDir)) {
    console.error(`a jonobones daemon is running on this profile — stop it first (jonobones stop --profile ${profileDir})`);
    process.exit(1);
  }

  let prompter: Prompter | null = null;
  let ctx: JoplinContext | null = null;
  try {
    console.log(`jonobones init — profile: ${profileDir}\n`);

    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    chmodSync(profileDir, 0o700);

    console.log('opening the knowledge base (a stock Joplin client profile)…');
    ctx = await bootstrapJoplin({ profileDir });

    // Created only now: a readline interface discards piped lines that
    // arrive while no question is pending, so it must not exist across the
    // slow bootstrap above.
    prompter = new Prompter();

    const configPath = join(profileDir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      const overwrite = await prompter.confirm(`${configPath} already exists. Reconfigure (overwrites it)?`, false);
      if (!overwrite) {
        console.log('aborted; existing config left untouched.');
        process.exit(1);
      }
    }

    // -- target + connectivity -------------------------------------------
    let syncSection: Record<string, unknown>;
    let runner: SyncRunner;
    for (;;) {
      const choice = await prompter.choose('\npick a sync target:', WIZARD_TARGETS);
      syncSection = await collectTargetParams(prompter, ctx, choice.key);
      const resolved = resolveSyncTarget(syncSection)!;
      applySyncTarget(ctx, resolved);
      runner = new SyncRunner(ctx, resolved.spec);

      process.stdout.write('testing connection… ');
      try {
        await runner.testConnection();
        console.log('ok');
        break;
      } catch (error) {
        console.log(`failed: ${(error as Error).message}`);
        const retry = await prompter.confirm('try again with different settings?', true);
        if (!retry) {
          console.log('aborted.');
          process.exit(1);
        }
      }
    }

    // -- first sync (this *is* the import step) ---------------------------
    console.log('\nrunning the first sync — this populates the knowledge base…');
    const result = await runner.run();
    if (!result.ok) {
      console.error(`first sync failed: ${result.error}`);
      console.error('aborted; fix the problem and re-run jonobones init.');
      process.exit(1);
    }
    if (result.itemErrors.length) {
      console.warn(`sync completed with ${result.itemErrors.length} item error(s); first: ${result.itemErrors[0]}`);
    } else {
      console.log('first sync complete.');
    }

    // -- E2EE --------------------------------------------------------------
    const e2eeSection: Record<string, unknown> = {};
    const syncInfo = ctx.lib.syncInfoUtils.localSyncInfo();
    const hasMasterKeys = (syncInfo?.masterKeys?.length ?? 0) > 0;
    if (ctx.lib.syncInfoUtils.getEncryptionEnabled() || hasMasterKeys) {
      console.log('\nthis sync target uses end-to-end encryption.');
      console.log('the daemon needs the master password at every boot, so it will be stored in config.json5 (0600).');
      for (;;) {
        const password = await prompter.askHidden('master password (empty to skip — data will stay encrypted)');
        if (password === '') {
          console.warn('skipping E2EE setup; encrypted items will not be readable until configured.');
          break;
        }
        if (await ctx.lib.e2eeUtils.masterPasswordIsValid(password)) {
          e2eeSection.masterPassword = password;
          await applyE2eePassword(ctx, password);
          console.log('decrypting (this can take a while on large knowledge bases)…');
          try {
            await ctx.services.decryptionWorker.start();
          } catch (error) {
            console.warn(`decryption reported: ${(error as Error).message}`);
          }
          console.log('decryption pass finished.');
          break;
        }
        console.log('that password does not unlock the active master key — try again.');
      }
    }

    // -- token + config ----------------------------------------------------
    const token = randomBytes(24).toString('hex');
    const config = {
      api: { port: 26637, bind: '127.0.0.1', token },
      sync: { interval: 300, ...syncSection },
      ...(Object.keys(e2eeSection).length ? { e2ee: e2eeSection } : {}),
    };
    const body = `// jonobones configuration — flags > env (JONOBONES_*) > this file > defaults
${JSON.stringify(config, null, 2)}
`;
    writeFileSync(configPath, body, { mode: 0o600 });
    chmodSync(configPath, 0o600);

    console.log(`\nwrote ${configPath} (0600)`);
    console.log('\nall set. next steps:');
    console.log(`  jonobones start --profile ${flags.profile ?? 'default'}     # foreground; use your service manager to daemonize`);
    console.log(`  curl http://127.0.0.1:26637/v1/health`);
    console.log(`  curl -H "Authorization: Bearer ${token.slice(0, 8)}…" http://127.0.0.1:26637/v1/status`);
    console.log('\n(the full token is in config.json5 and lock.json)');
  } catch (error) {
    if (error instanceof StdinEndedError) {
      console.error('\nstdin ended before the wizard finished — jonobones init needs an interactive terminal.');
      process.exit(1);
    }
    throw error;
  } finally {
    prompter?.close();
    if (ctx) await ctx.shutdown();
  }
}
