import type { Config } from './types.js';

export function defaultConfig(): Config {
  return {
    api: {
      // "BONES" on a phone keypad. Deliberately far from Joplin's own 41184.
      port: 26637,
      bind: '127.0.0.1',
    },
    sync: {
      target: 'filesystem',
      interval: 300,
    },
    e2ee: {},
  };
}
