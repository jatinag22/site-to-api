import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'site-to-api',
          include: ['packages/site-to-api/{src,test}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'runtime',
          include: ['packages/runtime/{src,test}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
})
