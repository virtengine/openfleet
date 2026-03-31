import { resolve } from "node:path";
import { availableParallelism, cpus } from "node:os";
import * as vitestConfig from "vitest/config";

const defineConfig =
  vitestConfig.defineConfig ??
  vitestConfig.default?.defineConfig ??
  ((config) => config);

function detectParallelism() {
  try {
    if (typeof availableParallelism === "function") {
      return availableParallelism();
    }
  } catch {
    // Fall through to cpu count.
  }
  return Array.isArray(cpus?.()) && cpus().length > 0 ? cpus().length : 4;
}

function parseWorkerCount(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const detectedParallelism = detectParallelism();
const windowsSuggestedMaxWorkers = Math.max(
  2,
  Math.min(6, Math.floor(detectedParallelism / 2) || 2),
);
const windowsSuggestedMinWorkers = Math.max(
  1,
  Math.min(3, Math.floor(windowsSuggestedMaxWorkers / 2) || 1),
);
const windowsDefaultMaxWorkers = parseWorkerCount(
  process.env.BOSUN_VITEST_MAX_WORKERS,
  windowsSuggestedMaxWorkers,
);
const windowsDefaultMinWorkers = Math.min(
  parseWorkerCount(process.env.BOSUN_VITEST_MIN_WORKERS, windowsSuggestedMinWorkers),
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
