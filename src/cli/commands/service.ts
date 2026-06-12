// `jonobones service install|uninstall` — register the daemon with the
// user-level service manager: launchd on macOS, systemd (user) on Linux.
// The daemon itself stays a foreground process; supervision is the service
// manager's job (plan §6).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { resolveProfileDir } from '../../config/profile.js';
import type { CliFlags } from '../../config/types.js';

function profileLabel(profileDir: string): string {
  return basename(profileDir).replaceAll(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || 'default';
}

export interface ServicePaths {
  kind: 'launchd' | 'systemd';
  unitPath: string;
  label: string;
}

export function servicePaths(profileDir: string, osPlatform = platform()): ServicePaths {
  const label = profileLabel(profileDir);
  if (osPlatform === 'darwin') {
    return {
      kind: 'launchd',
      label: `org.parkviewlab.jonobones.${label}`,
      unitPath: join(homedir(), 'Library', 'LaunchAgents', `org.parkviewlab.jonobones.${label}.plist`),
    };
  }
  if (osPlatform === 'linux') {
    return {
      kind: 'systemd',
      label: `jonobones-${label}`,
      unitPath: join(
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'systemd',
        'user',
        `jonobones-${label}.service`,
      ),
    };
  }
  throw new Error(`service install is supported on macOS (launchd) and Linux (systemd), not ${osPlatform}`);
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function launchdPlist(label: string, nodeBin: string, cliScript: string, profileDir: string): string {
  const logDir = join(profileDir, 'logs');
  const args = [nodeBin, cliScript, 'start', '--profile', profileDir];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, 'jonobones.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, 'jonobones.err.log'))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(nodeBin: string, cliScript: string, profileDir: string): string {
  return `[Unit]
Description=jonobones — headless, Joplin-sync-compatible knowledge daemon (${profileDir})
After=network-online.target

[Service]
ExecStart=${nodeBin} ${cliScript} start --profile ${profileDir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

export async function commandService(subcommand: string | undefined, flags: CliFlags): Promise<void> {
  if (subcommand !== 'install' && subcommand !== 'uninstall') {
    console.error('usage: jonobones service install|uninstall [--profile <name|path>]');
    process.exit(2);
  }

  const profileDir = resolveProfileDir(flags.profile);
  const paths = servicePaths(profileDir);
  const nodeBin = process.execPath;
  const cliScript = process.argv[1]!;

  if (subcommand === 'install') {
    mkdirSync(join(profileDir, 'logs'), { recursive: true });
    mkdirSync(join(paths.unitPath, '..'), { recursive: true });

    if (paths.kind === 'launchd') {
      writeFileSync(paths.unitPath, launchdPlist(paths.label, nodeBin, cliScript, profileDir));
      const domain = `gui/${userInfo().uid}`;
      try {
        run('launchctl', ['bootstrap', domain, paths.unitPath]);
      } catch {
        // Older macOS fallback.
        run('launchctl', ['load', '-w', paths.unitPath]);
      }
      console.log(`installed and started launchd agent ${paths.label}`);
      console.log(`  plist: ${paths.unitPath}`);
      console.log(`  logs:  ${join(profileDir, 'logs')}`);
    } else {
      writeFileSync(paths.unitPath, systemdUnit(nodeBin, cliScript, profileDir));
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', paths.label]);
      console.log(`installed and started systemd user unit ${paths.label}`);
      console.log(`  unit: ${paths.unitPath}`);
      console.log(`  logs: journalctl --user -u ${paths.label}`);
    }
    return;
  }

  // uninstall
  if (!existsSync(paths.unitPath)) {
    console.log(`no service unit found at ${paths.unitPath}`);
    return;
  }
  if (paths.kind === 'launchd') {
    const domain = `gui/${userInfo().uid}`;
    try {
      run('launchctl', ['bootout', `${domain}/${paths.label}`]);
    } catch {
      try {
        run('launchctl', ['unload', '-w', paths.unitPath]);
      } catch {
        // Not loaded — fine, still remove the plist.
      }
    }
    rmSync(paths.unitPath, { force: true });
    console.log(`removed launchd agent ${paths.label}`);
  } else {
    try {
      run('systemctl', ['--user', 'disable', '--now', paths.label]);
    } catch {
      // Not enabled — fine.
    }
    rmSync(paths.unitPath, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    console.log(`removed systemd user unit ${paths.label}`);
  }
}
