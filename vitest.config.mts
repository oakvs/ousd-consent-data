import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['pipeline/**/*.test.ts', 'packages/**/*.test.ts'],
    environment: 'node',
    // Several tests read every committed data file; that takes a few seconds on CI runners.
    testTimeout: 30_000,
  },
})
