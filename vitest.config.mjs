import { resolve } from "node:path";
import * as vitestConfig from "vitest/config";

const defineConfig =
  vitestConfig.defineConfig ??
  vitestConfig.default?.defineConfig ??
  ((config) => config);

const stripShebangPlugin = {
  name: "strip-shebang",
  enforce: "pre",
  transform(code, id) {
    if (!/\.(?:[cm]?js|mjs)$/.test(id)) return null;
    const normalized = String(code || "");
    if (!/^\ufeff?#!/.test(normalized)) return null;
    return {
      code: normalized.replace(/^\ufeff?#![^\n]*\r?\n?/, ""),
      map: null,
    };
  },
};

export default defineConfig({
  plugins: [stripShebangPlugin],
  esbuild: false,
  keepProcessEnv: true,
  resolve: {
    alias: {
      "@openai/codex-sdk": resolve(process.cwd(), "tests", "shims", "codex-sdk.mjs"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.mjs"],
    exclude: [
      "**/node_modules/**",
      "**/.cache/**",
      "**/*.node.test.mjs",
      ...(process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED === "1"
        ? ["tests/workflow-task-lifecycle.test.mjs"]
        : []),
    ],
    testTimeout: 5000,
    pool: "threads",
    minWorkers: process.platform === "win32" ? 1 : undefined,
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    setupFiles: ["tests/setup.mjs"],
  },
});
