import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The e2e tier boots Docker containers; it runs only via `npm run
    // test:e2e` (vitest.e2e.config.ts), never as part of `npm test`.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
