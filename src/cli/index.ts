import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, validateConfigForServe } from '../config/load.js';
import { AlreadyRunningError } from '../config/lockfile.js';
import { resolveProfileDir } from '../config/profile.js';
import { ConfigError, type CliFlags } from '../config/types.js';
import { startDaemon } from '../daemon.js';
import { commandInit } from './commands/init.js';
import { commandStatus, commandStop, commandSync } from './commands/control.js';
import { commandService } from './commands/service.js';
import { VERSION } from '../version.js';

const USAGE = `jonobones ${VERSION} — a headless, Joplin-sync-compatible knowledge daemon

usage: jonobones <command> [options]

commands:
  init                  interactive setup: sync target, first sync, E2EE, token
  start                 run the daemon in the foreground
  stop                  stop the daemon for this profile
  status                show daemon + sync + e2ee status
  sync                  trigger a sync cycle now
  service install       register with launchd (macOS) / systemd --user (Linux)
  service uninstall     remove the service registration

options:
  --profile <name|path> profile to use (default: "default")
  --port <port>         override api.port
  --bind <address>      override api.bind
  --help                show this help
  --version             show version

run \`jonobones <command> --help\` is not a thing yet — this is the full list.`;

interface ParsedCli {
  command: string | undefined;
  subcommand: string | undefined;
  flags: CliFlags;
  help: boolean;
  version: boolean;
}

export function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      port: { type: 'string' },
      bind: { type: 'string' },
      token: { type: 'string' },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  });

  const flags: CliFlags = {};
  if (values.profile !== undefined) flags.profile = values.profile;
  if (values.bind !== undefined) flags.bind = values.bind;
  if (values.token !== undefined) flags.token = values.token;
  if (values.port !== undefined) {
    const port = parseInt(values.port, 10);
    if (Number.isNaN(port)) throw new ConfigError(`--port must be a number, got ${JSON.stringify(values.port)}`);
    flags.port = port;
  }

  return {
    command: positionals[0],
    subcommand: positionals[1],
    flags,
    help: values.help,
    version: values.version,
  };
}

async function commandStart(flags: CliFlags): Promise<void> {
  const profileDir = resolveProfileDir(flags.profile);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const config = loadConfig({ profileDir, flags });
  validateConfigForServe(config);

  let daemon;
  try {
    daemon = await startDaemon({ profileDir, config });
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      // By design (plan §2.9): a second invocation is not an error.
      console.log(`jonobones is already running on port ${error.lock.port} (pid ${error.lock.pid})`);
      process.exit(0);
    }
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`jonobones ${VERSION} serving ${daemon.address}/v1 (profile: ${profileDir})`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  if (parsed.version) {
    console.log(VERSION);
    return;
  }
  if (parsed.help || parsed.command === undefined || parsed.command === 'help') {
    console.log(USAGE);
    if (parsed.command === undefined && !parsed.help) process.exitCode = 2;
    return;
  }

  const commands: Record<string, (flags: typeof parsed.flags) => Promise<void>> = {
    start: commandStart,
    init: commandInit,
    stop: commandStop,
    status: commandStatus,
    sync: commandSync,
  };

  if (parsed.command === 'service') {
    await commandService(parsed.subcommand, parsed.flags);
    return;
  }

  const command = commands[parsed.command];
  if (command) {
    try {
      await command(parsed.flags);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`config error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  console.error(`unknown command: ${parsed.command}\n`);
  console.error(USAGE);
  process.exit(2);
}
