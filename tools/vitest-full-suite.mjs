import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPackageRoot, runVitest } from "./vitest-runner.mjs";

const DEFAULT_HEAVY_SUITES = [
  "tests/ui-server.test.mjs",
  "tests/workflow-engine.test.mjs",
  "tests/workflow-guaranteed.test.mjs",
  "tests/workflow-task-lifecycle.test.mjs",
  "tests/workflow-templates.test.mjs",
  "tests/agent-pool.test.mjs",
  "tests/bosun-native-workflow-nodes.test.mjs",
  "tests/workflow-templates-e2e.test.mjs",
];

function parseCsvEnv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function listVitestSuiteFiles({ startDir = process.cwd() } = {}) {
  const packageRoot = findPackageRoot({ startDir }) || startDir;
  const testsDir = resolve(packageRoot, "tests");
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".test.mjs") && !name.endsWith(".node.test.mjs"))
    .map((name) => `tests/${name}`)
    .sort();
}

function resolveHeavySuites(allSuites) {
  const configured = parseCsvEnv(process.env.BOSUN_VITEST_HEAVY_SUITES);
  const heavyCandidates = configured.length > 0 ? configured : DEFAULT_HEAVY_SUITES;
  const available = new Set(allSuites);
  return heavyCandidates.filter((suite) => available.has(suite));
}

export function buildVitestFullSuitePlan({ startDir = process.cwd() } = {}) {
  const allSuites = listVitestSuiteFiles({ startDir });
  const heavySuites = resolveHeavySuites(allSuites);
  const heavySet = new Set(heavySuites);
  const groupedSuites = allSuites.filter((suite) => !heavySet.has(suite));
  return {
    allSuites,
    groupedSuites,
    heavySuites,
  };
}

export function buildVitestBatchArgs(files, { maxWorkers } = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const args = ["run", "--config", "vitest.config.mjs"];
  if (maxWorkers) args.push("--maxWorkers", String(maxWorkers));
  args.push(...files);
  return args;
}

function withTemporaryEnv(envOverrides = {}, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(envOverrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resolveSuiteShardCount(suite) {
  if (suite !== "tests/workflow-guaranteed.test.mjs") return 1;
  const configured = Number.parseInt(
    String(process.env.BOSUN_VITEST_WORKFLOW_GUARANTEED_SHARDS || ""),
    10,
  );
  if (Number.isFinite(configured) && configured > 1) return configured;
  return process.platform === "win32" ? 8 : 1;
}

function runBatch(files, { startDir = process.cwd(), maxWorkers, label, heapMb, envOverrides } = {}) {
  const args = buildVitestBatchArgs(files, { maxWorkers });
  if (args.length === 0) return 0;
  if (label) {
    console.log(`[vitest-full-suite] ${label}: ${files.length} file(s)`);
  }
  const effectiveEnvOverrides = { ...(envOverrides || {}) };
  if (Number.isFinite(heapMb) && heapMb >= 2048) {
    effectiveEnvOverrides.BOSUN_VITEST_HEAP_MB = String(heapMb);
  }
  return withTemporaryEnv(effectiveEnvOverrides, () => runVitest(args, { startDir }));
}

function runFullSuite({ startDir = process.cwd() } = {}) {
  const { groupedSuites, heavySuites, allSuites } = buildVitestFullSuitePlan({ startDir });
  if (allSuites.length === 0) {
    console.log("[vitest-full-suite] no Vitest suites found");
    return 0;
  }

  const groupedMaxWorkers = Number.parseInt(
    String(process.env.BOSUN_VITEST_MAX_WORKERS || (process.platform === "win32" ? "4" : "")),
    10,
  );
  const groupedBatchSize = Number.parseInt(
    String(process.env.BOSUN_VITEST_GROUP_BATCH_SIZE || (process.platform === "win32" ? "12" : "0")),
    10,
  );
  const isolatedMaxWorkers = Number.parseInt(
    String(process.env.BOSUN_VITEST_ISOLATED_MAX_WORKERS || "1"),
    10,
  );
  const isolatedHeapMb = Number.parseInt(
    String(process.env.BOSUN_VITEST_ISOLATED_HEAP_MB || (process.platform === "win32" ? "12288" : "4096")),
    10,
  );

  if (groupedSuites.length > 0) {
    const effectiveGroupedMaxWorkers =
      Number.isFinite(groupedMaxWorkers) && groupedMaxWorkers > 0 ? groupedMaxWorkers : undefined;
    const effectiveGroupedBatchSize =
      Number.isFinite(groupedBatchSize) && groupedBatchSize > 0 ? groupedBatchSize : groupedSuites.length;

    for (let index = 0; index < groupedSuites.length; index += effectiveGroupedBatchSize) {
      const batch = groupedSuites.slice(index, index + effectiveGroupedBatchSize);
      const batchLabel = effectiveGroupedBatchSize >= groupedSuites.length
        ? "grouped batch"
        : `grouped batch ${Math.floor(index / effectiveGroupedBatchSize) + 1}/${Math.ceil(groupedSuites.length / effectiveGroupedBatchSize)}`;
      const code = runBatch(batch, {
        startDir,
        maxWorkers: effectiveGroupedMaxWorkers,
        label: batchLabel,
      });
      if (code !== 0) return code;
    }
  }

  for (const suite of heavySuites) {
    const suiteShardCount = resolveSuiteShardCount(suite);
    if (suiteShardCount > 1) {
      for (let shard = 1; shard <= suiteShardCount; shard += 1) {
        const code = runBatch([suite], {
          startDir,
          maxWorkers: Number.isFinite(isolatedMaxWorkers) && isolatedMaxWorkers > 0 ? isolatedMaxWorkers : 1,
          label: `isolated suite ${suite} shard ${shard}/${suiteShardCount}`,
          heapMb: Number.isFinite(isolatedHeapMb) && isolatedHeapMb >= 2048 ? isolatedHeapMb : undefined,
          envOverrides: {
            VITEST_SHARD: String(shard),
            VITEST_TOTAL_SHARDS: String(suiteShardCount),
          },
        });
        if (code !== 0) return code;
      }
      continue;
    }

    const code = runBatch([suite], {
      startDir,
      maxWorkers: Number.isFinite(isolatedMaxWorkers) && isolatedMaxWorkers > 0 ? isolatedMaxWorkers : 1,
      label: `isolated suite ${suite}`,
      heapMb: Number.isFinite(isolatedHeapMb) && isolatedHeapMb >= 2048 ? isolatedHeapMb : undefined,
      envOverrides: {
        VITEST_SHARD: null,
        VITEST_TOTAL_SHARDS: null,
      },
    });
    if (code !== 0) return code;
  }

  return 0;
}

function isDirectExecution(argv = process.argv) {
  const scriptPath = argv?.[1];
  if (!scriptPath) return false;
  return resolve(scriptPath) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const extraArgs = process.argv.slice(2);
    if (extraArgs.length > 0) {
      const vitestArgs = extraArgs[0] === "run" ? extraArgs : ["run", ...extraArgs];
      process.exit(runVitest(vitestArgs));
    }
    process.exit(runFullSuite());
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
