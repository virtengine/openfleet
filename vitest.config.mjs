import { resolve } from "node:path";
import * as vitestConfig from "vitest/config";

const defineConfig =
  vitestConfig.defineConfig ??
  vitestConfig.default?.defineConfig ??
  ((config) => config);

function parseWorkerCount(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const windowsDefaultMaxWorkers = parseWorkerCount(
  process.env.BOSUN_VITEST_MAX_WORKERS,
  2,
);
const windowsDefaultMinWorkers = Math.min(
  parseWorkerCount(process.env.BOSUN_VITEST_MIN_WORKERS, 1),
  windowsDefaultMaxWorkers,
);

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
    // Several Bosun integration suites intentionally mutate process.env and
    // other singleton runtime state. Run files in isolated worker processes so
    // cross-file leakage does not cause nondeterministic timeouts.
    pool: "forks",
    minWorkers: process.platform === "win32" ? windowsDefaultMinWorkers : undefined,
    maxWorkers: process.platform === "win32" ? windowsDefaultMaxWorkers : undefined,
    setupFiles: ["tests/setup.mjs"],
  },
});
