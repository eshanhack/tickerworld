import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    include: ['tests/**/*.test.ts', 'tests/**/*.integration.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
