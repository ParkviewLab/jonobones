import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const APP_NAME = 'jonobones';
export const VERSION = pkg.version;

// Bumped only on breaking API change, together with the /v1 URL prefix.
export const API_VERSION = 1;
