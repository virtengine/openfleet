import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "server",
  testMatch: "playwright-ui-*.mjs",
  timeout: 30000,
  webServer: {
    command: "node server/playwright-ui-server.mjs",
    url: "http://localhost:4444",
    reuseExistingServer: true,
    timeout: 30000,
  },
  use: {
    baseURL: "http://localhost:4444",
    headless: true,
    ignoreHTTPSErrors: true,
  },
  reporter: "list",
});
