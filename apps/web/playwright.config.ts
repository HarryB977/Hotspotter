import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
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
