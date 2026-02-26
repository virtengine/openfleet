import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.mjs"],
    exclude: [
      "**/node_modules/**",
      "**/.cache/**",
      "**/*.node.test.mjs",
      "**/maintenance-warning-throttle.test.mjs",
      "**/telegram-poll-conflict-cooldown.test.mjs",
    ],
    testTimeout: 5000,
    pool: "threads",
    setupFiles: ["tests/setup.mjs"],
  },
});
