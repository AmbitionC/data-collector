import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@data-collector/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.d.ts'],
    },
  },
});
