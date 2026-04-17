import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: ['tests/desktop/**/*.test.ts', 'tests/desktop/**/*.test.tsx', 'tests/unit/**/*.test.tsx'],
          environment: 'node',
          coverage: {
            reporter: ['text', 'html'],
            reportsDirectory: 'coverage',
          },
        },
      },
      {
        test: {
          name: 'dom',
          include: ['tests/desktop/**/*.test.ts', 'tests/desktop/**/*.test.tsx', 'tests/unit/**/*.test.tsx'],
          environment: 'jsdom',
          coverage: {
            reporter: ['text', 'html'],
            reportsDirectory: 'coverage',
          },
        },
      },
    ],
  },
});
