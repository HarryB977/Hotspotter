import { defineConfig } from 'vitest/config';

// Unit tests only; the Playwright specs in e2e/ run through `npm run e2e`.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
