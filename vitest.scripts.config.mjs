import { defineConfig } from 'vitest/config'

// Used explicitly via --config (a root vitest.config would leak into the workspaces). Only the release scripts. Each workspace runs its own vitest.
export default defineConfig({
  test: { include: ['scripts/**/*.test.mjs'] },
})
