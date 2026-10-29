import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests import the runtime from source, so they do not depend on a prior build. This also covers
// generated clients that tests write to temporary folders and import.
const runtimeSource = fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url))

export default defineConfig({
  test: {
    // Generated clients are recorded as trusted in the config directory (decision 0043); tests
    // keep that store out of the person's own ~/.config.
    env: {
      XDG_CONFIG_HOME: join(tmpdir(), 'site-to-api-test-config'),
    },
    projects: [
      {
        extends: true,
        resolve: {
          alias: { '@site-to-api/runtime': runtimeSource },
        },
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
