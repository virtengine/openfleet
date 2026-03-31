import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPackageRoot, runVitest } from "./vitest-runner.mjs";

const DEFAULT_HEAVY_SUITES = [
  "tests/ui-server.test.mjs",
  "tests/workflow-engine.test.mjs",
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

function runBatch(files, { startDir = process.cwd(), maxWorkers, label } = {}) {
  const args = buildVitestBatchArgs(files, { maxWorkers });
  if (args.length === 0) return 0;
  if (label) {
    console.log(`[vitest-full-suite] ${label}: ${files.length} file(s)`);
  }
  return runVitest(args, { startDir });
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
    const code = runBatch([suite], {
      startDir,
      maxWorkers: Number.isFinite(isolatedMaxWorkers) && isolatedMaxWorkers > 0 ? isolatedMaxWorkers : 1,
      label: `isolated suite ${suite}`,
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
      process.exit(runVitest(extraArgs));
    }
    process.exit(runFullSuite());
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
