import { defineConfig } from 'vitest/config';

// The e2e tier: a real Joplin Server in Docker + the official joplin CLI +
// the example app, all talking through one daemon. Run via `npm run
// test:e2e`. Suites self-skip when docker or the joplin CLI is missing.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 240_000,
    // Cold runs may docker-pull the server image inside beforeAll.
    hookTimeout: 300_000,
    // One Joplin Server container + one CLI profile at a time: suites run
    // sequentially so container boots don't race for ports or CPU.
    fileParallelism: false,
    globalSetup: ['tests/e2e/global-setup.ts'],
  },
});
