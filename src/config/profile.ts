import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_PROFILE_NAME = 'default';

export function profilesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ''
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(configHome, 'jonobones');
}

// --profile accepts either a profile name (a directory under the profiles
// root) or a filesystem path (anything containing a path separator, or
// starting with ~, ., or /).
export function resolveProfileDir(profileArg?: string, env: NodeJS.ProcessEnv = process.env): string {
  const arg = profileArg?.trim();
  if (!arg) return join(profilesRoot(env), DEFAULT_PROFILE_NAME);

  if (arg.startsWith('~/') || arg === '~') {
    return resolve(join(homedir(), arg.slice(1)));
  }
  if (isAbsolute(arg) || arg.includes('/') || arg.startsWith('.')) {
    return resolve(arg);
  }
  return join(profilesRoot(env), arg);
}
