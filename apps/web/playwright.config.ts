import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // The visual bench (bench.spec.ts, @bench) only runs through `npm run bench`, which sets HS_BENCH=1.
  grepInvert: process.env.HS_BENCH === '1' ? undefined : /@bench/,
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    launchOptions: { args: ['--enable-unsafe-webgpu'] },
  },
  webServer: [
    {
      command: 'npm run start -w @hotspotter/server',
      url: 'http://127.0.0.1:7420/api/health',
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev -w @hotspotter/web',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
    },
  ],
});
