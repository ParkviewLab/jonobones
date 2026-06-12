import { describe, expect, it } from 'vitest';
import { launchdPlist, servicePaths, systemdUnit } from '../../src/cli/commands/service.js';

describe('servicePaths', () => {
  it('derives launchd paths on darwin', () => {
    const p = servicePaths('/Users/x/.config/jonobones/work', 'darwin');
    expect(p.kind).toBe('launchd');
    expect(p.label).toBe('org.parkviewlab.jonobones.work');
    expect(p.unitPath).toContain('Library/LaunchAgents/org.parkviewlab.jonobones.work.plist');
  });

  it('derives systemd paths on linux and sanitizes labels', () => {
    const p = servicePaths('/home/x/.config/jonobones/My Profile!', 'linux');
    expect(p.kind).toBe('systemd');
    expect(p.label).toBe('jonobones-my-profile-');
    expect(p.unitPath).toContain('systemd/user/jonobones-my-profile-.service');
  });

  it('rejects other platforms', () => {
    expect(() => servicePaths('/x', 'win32')).toThrow(/launchd.*systemd|systemd.*launchd/);
  });
});

describe('unit file generation', () => {
  it('launchd plist contains the full start invocation and log paths', () => {
    const plist = launchdPlist('org.parkviewlab.jonobones.default', '/usr/local/bin/node', '/opt/jb/bin/jonobones.js', '/p/default');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/opt/jb/bin/jonobones.js</string>');
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('<string>--profile</string>');
    expect(plist).toContain('<string>/p/default</string>');
    expect(plist).toContain('/p/default/logs/jonobones.log');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('escapes XML-sensitive characters in plists', () => {
    const plist = launchdPlist('l', '/node', '/cli.js', '/p/a&b<c>');
    expect(plist).toContain('/p/a&amp;b&lt;c&gt;');
    expect(plist).not.toContain('a&b<c>');
  });

  it('systemd unit restarts on failure and starts in the foreground', () => {
    const unit = systemdUnit('/usr/bin/node', '/opt/jb/bin/jonobones.js', '/p/default');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/jb/bin/jonobones.js start --profile /p/default');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
});
