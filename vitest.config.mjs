import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/.cache/**"],
    testTimeout: 5000,
    pool: "threads",
    setupFiles: ["tests/setup.mjs"],
  },
});
