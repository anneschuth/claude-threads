import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/onboarding.ts',
        'src/**/*.test.ts',
        'src/**/types.ts',
      ],
      // Thresholds will be enforced per-file for now
      // Global thresholds disabled until we have more test coverage
      // thresholds: {
      //   lines: 30,
      //   functions: 30,
      //   branches: 30,
      //   statements: 30,
      // },
    },
  },
});
