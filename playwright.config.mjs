import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "playwright-ui-inspect.mjs",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:4444",
    headless: true,
    ignoreHTTPSErrors: true,
  },
  reporter: "list",
});
