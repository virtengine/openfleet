import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@openai/codex-sdk": resolve(process.cwd(), "tests", "shims", "codex-sdk.mjs"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/.cache/**", "**/*.node.test.mjs"],
    testTimeout: 5000,
    pool: "threads",
    setupFiles: ["tests/setup.mjs"],
  },
});
