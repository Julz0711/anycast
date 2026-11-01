import { defineConfig } from 'vitest/config';

/** Opt-in scale suite (minutes): pnpm --filter @anycast/server test:perf */
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.ts'],
    testTimeout: 300_000,
    hookTimeout: 900_000,
    pool: 'forks',
  },
});
