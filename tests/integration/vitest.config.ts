import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120000, // 2 min for container startup
    hookTimeout: 120000,
    poolOptions: {
      forks: {
        singleFork: true, // Run integration tests sequentially to avoid container conflicts
      },
    },
  },
});
