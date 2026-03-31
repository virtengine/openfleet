import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  findPackageRoot,
  findVitestEntry,
  isDirectExecution,
  resolveVitestArgs,
} from "../tools/vitest-runner.mjs";
import { buildVitestBatchArgs, buildVitestFullSuitePlan } from "../tools/vitest-full-suite.mjs";

const tempDirs = [];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-vitest-runner-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("vitest-runner", () => {
  it("keeps the pre-push adjacency map aligned with newer non-prefixed suites", () => {
    const prePushHook = readFileSync(resolve(repoRoot, ".githooks", "pre-push"), "utf8");

    expect(prePushHook).toContain('"workflow/|workflow-*|workflow-task-lifecycle*|workflow-write-file-encoding*|workflow-pipeline-primitives*|workflow-research-evidence-sidecar*|manual-flows*|mcp-workflow-adapter*|bosun-native-workflow-nodes*|meeting-workflow*|run-evaluator*|state-ledger-sqlite*|webhook-gateway*|credential-store*|cron-scheduler*"');
    expect(prePushHook).toContain('"infra/|monitor-*|heartbeat-monitor*|daemon-*|restart-*|startup-*|maintenance-*|anomaly-*|preflight*|tracing*|tui-bridge*|windows-hidden-child-processes*|weekly-agent-work-report*|workflow-task-lifecycle*|workflow-engine*"');
    expect(prePushHook).toContain('"agent/|agent-*|primary-agent*|fleet-*|review-agent*|analyze-agent*|autofix*|streaming-agent*|hook-library*|weekly-agent-work-report*|internal-harness*"');
    expect(prePushHook).toContain('"telegram/|telegram-*|whatsapp-*|weekly-agent-work-report*"');
    expect(prePushHook).toContain('"task/|task-*|workflow-task-lifecycle*|kanban-*|state-ledger-sqlite*|ve-orchestrator*|vk-api*|ve-kanban*"');
    expect(prePushHook).toContain('"lib/|logger*|utils*|library-*|error-detector*|context-*|codebase-audit*|repo-map*|state-ledger-sqlite*"');
  });
  it("finds vitest from an ancestor node_modules directory", () => {
    const root = createFixture();
    const vitestEntry = resolve(root, "node_modules", "vitest", "vitest.mjs");
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-123");

    mkdirSync(resolve(vitestEntry, ".."), { recursive: true });
    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(vitestEntry, "export default {};\n");

    expect(findVitestEntry({ startDir: nestedWorktree })).toBe(vitestEntry);
  });

  it("returns null when vitest is unavailable in any ancestor", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-456");
    mkdirSync(nestedWorktree, { recursive: true });

    expect(findVitestEntry({ startDir: nestedWorktree })).toBeNull();
  });

  it("finds the nearest package root from a nested worktree path", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-789", "deep");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    expect(findPackageRoot({ startDir: nestedWorktree })).toBe(root);
  });

  it("resolves relative config paths from the package root when invoked in a nested worktree", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-999", "deep");
    const configPath = resolve(root, "vitest.config.mjs");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    writeFileSync(configPath, "export default {};\n");

    const expected = ["run", "--config", configPath];
    if (process.platform === "win32") {
      expected.push("--configLoader", "runner");
    }

    expect(
      resolveVitestArgs(["run", "--config", "vitest.config.mjs"], {
        startDir: nestedWorktree,
      }),
    ).toEqual(expected);
  });

  it("routes package test scripts through the worktree-safe runner", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

    expect(packageJson.scripts.test).toContain("tools/vitest-full-suite.mjs");
    expect(packageJson.scripts["test:vitest"]).toContain("tools/vitest-full-suite.mjs");
    expect(packageJson.scripts["prepush:check"]).toContain("npm run test:all");
    expect(packageJson.scripts["test:node"]).toContain("--no-warnings=ExperimentalWarning");
    expect(packageJson.scripts.test).not.toContain("node_modules/vitest/vitest.mjs");
    expect(packageJson.scripts["test:vitest"]).not.toContain("node_modules/vitest/vitest.mjs");
  });

  it("isolates heavyweight suites from the grouped full-suite batch", () => {
    const { groupedSuites, heavySuites } = buildVitestFullSuitePlan({ startDir: repoRoot });

    expect(heavySuites).toContain("tests/workflow-engine.test.mjs");
    expect(heavySuites).toContain("tests/workflow-templates-e2e.test.mjs");
    expect(groupedSuites).not.toContain("tests/workflow-engine.test.mjs");
    expect(groupedSuites).not.toContain("tests/workflow-templates-e2e.test.mjs");
    expect(groupedSuites.length + heavySuites.length).toBeGreaterThan(0);
  });

  it("builds full-suite vitest batches without unsupported minWorkers flags", () => {
    expect(
      buildVitestBatchArgs(["tests/workflow-engine.test.mjs"], { maxWorkers: 1 }),
    ).toEqual([
      "run",
      "--config",
      "vitest.config.mjs",
      "--maxWorkers",
      "1",
      "tests/workflow-engine.test.mjs",
    ]);
  });

  it("caps grouped full-suite worker fan-out on Windows by default", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "vitest-full-suite.mjs"), "utf8");
    expect(source).toContain('process.env.BOSUN_VITEST_MAX_WORKERS || (process.platform === "win32" ? "4" : "")');
    expect(source).toContain('process.env.BOSUN_VITEST_GROUP_BATCH_SIZE || (process.platform === "win32" ? "48" : "0")');
  });

  it("routes the pre-push hook through the worktree-safe runner", () => {
    const prePushHook = readFileSync(resolve(repoRoot, ".githooks", "pre-push"), "utf8");

    expect(prePushHook).toContain('local -a runner_args=(run --config vitest.config.mjs)');
    expect(prePushHook).toContain('local -a bounded_runner_args=("${runner_args[@]}" --maxWorkers 1)');
    expect(prePushHook).toContain('node tools/vitest-runner.mjs "${bounded_runner_args[@]}"');
    expect(prePushHook).toContain('tests/*workflow*e2e*.test.mjs)');
    expect(prePushHook).toContain('tests/bosun-mcp-server.test.mjs|tests/ui-server*.test.mjs)');
    expect(prePushHook).toContain('local -a slice=("${regular_tests[@]:$offset:$batch_size}")');
    expect(prePushHook).toContain('local -a slice=("${tests[@]:$offset:$batch_size}")');
    expect(prePushHook).not.toContain("node node_modules/vitest/vitest.mjs");
  });

  it("detects direct execution for Windows-style script paths", () => {
    const scriptPath = resolve(repoRoot, "tools", "vitest-runner.mjs");

    expect(
      isDirectExecution([process.execPath, scriptPath]),
    ).toBe(true);
  });

  it("adds the runner config loader by default on Windows", () => {
    const restore = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(resolveVitestArgs(["run"])).toEqual([
        "run",
        "--configLoader",
        "runner",
      ]);
    } finally {
      Object.defineProperty(process, "platform", restore);
    }
  });

  it("preserves explicit config loader selection", () => {
    const restore = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(resolveVitestArgs(["run", "--configLoader", "native"])).toEqual([
        "run",
        "--configLoader",
        "native",
      ]);
      expect(resolveVitestArgs(["run", "--config-loader=runner"])).toEqual([
        "run",
        "--config-loader=runner",
      ]);
    } finally {
      Object.defineProperty(process, "platform", restore);
    }
  });

  it("includes the Windows realpath shim for Vitest child processes", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "vitest-runner.mjs"), "utf8");
    expect(source).toContain("vite-windows-realpath-shim.mjs");
    expect(source).toContain('nodeArgs.push("--import"');
    expect(source).toContain('--no-warnings=ExperimentalWarning');
    expect(source).toContain("--max-old-space-size=");
    expect(source).toContain("BOSUN_VITEST_HEAP_MB");
  });

  it("patches net use probes for Windows realpath handling", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "vite-windows-realpath-shim.mjs"), "utf8");
    expect(source).toContain("childProcess.exec = function patchedExec");
    expect(source).toContain('normalizedCommand === "net use"');
    expect(source).toContain("syncBuiltinESMExports()");
  });
});
