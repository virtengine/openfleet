import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/analyze-agent-work");
const DAY_MS = 24 * 60 * 60 * 1000;

async function readFixtureLines(fileName) {
  const raw = await readFile(resolve(FIXTURE_DIR, fileName), "utf8");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function createAnalyticsSandbox() {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "analyze-agent-work-"));
  const scriptDir = resolve(sandboxRoot, "repo/scripts/bosun");
  await mkdir(scriptDir, { recursive: true });

  await copyFile(
    resolve(process.cwd(), "analyze-agent-work.mjs"),
    resolve(scriptDir, "analyze-agent-work.mjs"),
  );
  await copyFile(
    resolve(process.cwd(), "task-complexity.mjs"),
    resolve(scriptDir, "task-complexity.mjs"),
  );

  const scriptPath = resolve(scriptDir, "analyze-agent-work.mjs");
  const scriptRepoRoot = resolve(dirname(scriptPath), "../..");
  const logDir = resolve(scriptRepoRoot, ".cache/agent-work-logs");
  await mkdir(logDir, { recursive: true });

  return { sandboxRoot, scriptDir, scriptPath, logDir };
}

async function writeLogFixtures(
  sandbox,
  {
    metricsLines = null,
    errorLines = null,
    includeMalformedErrorLine = false,
    omitErrorsLog = false,
  } = {},
) {
  const metricData = metricsLines || (await readFixtureLines("metrics.jsonl"));
  await writeFile(resolve(sandbox.logDir, "agent-metrics.jsonl"), `${metricData.join("\n")}\n`, "utf8");

  if (omitErrorsLog) {
    return;
  }

  const errors = [...(errorLines || (await readFixtureLines("errors.jsonl")))];
  if (includeMalformedErrorLine) {
    errors.push("{\"timestamp\":\"2099-02-21T10:10:00.000Z\",\"task_id\":\"bad\"");
  }
  await writeFile(resolve(sandbox.logDir, "agent-errors.jsonl"), `${errors.join("\n")}\n`, "utf8");
}

function runAnalyticsCli(sandbox, args) {
  return spawnSync(process.execPath, [sandbox.scriptPath, ...args], {
    cwd: sandbox.scriptDir,
    encoding: "utf8",
  });
}

function runInlineModuleScript(sandbox, source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: sandbox.scriptDir,
    encoding: "utf8",
  });
}

function parseJsonStdout(result) {
  const stdout = String(result.stdout || "").trim();
  try {
    return JSON.parse(stdout);
  } catch {
    assert.fail(
      `Expected JSON stdout.\nExit: ${result.status}\nSTDOUT:\n${stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
}

describe("analyze-agent-work CLI integration", () => {
  it("emits stable --error-correlation --json contract with ranked correlations", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      await writeLogFixtures(sandbox);
      const result = runAnalyticsCli(sandbox, [
        "--error-correlation",
        "--days",
        "7",
        "--top",
        "3",
        "--json",
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = parseJsonStdout(result);

      assert.equal(typeof payload.generated_at, "string");
      assert.equal(payload.window_days, 7);
      assert.equal(payload.top, 3);
      assert.equal(payload.total_errors, 5);
      assert.equal(payload.total_fingerprints, 3);
      assert.equal(payload.correlations.length, 3);

      assert.equal(payload.correlations[0].fingerprint, "timeout_api");
      assert.equal(payload.correlations[0].count, 2);
      assert.equal(payload.correlations[0].task_count, 1);
      assert.equal(payload.correlations[1].count, 2);

      assert.ok(payload.correlations.every((entry) => Array.isArray(entry.by_executor)));
      assert.ok(payload.correlations.every((entry) => Array.isArray(entry.by_size)));
      assert.ok(payload.correlations.every((entry) => Array.isArray(entry.by_complexity)));
      assert.ok(payload.correlations.every((entry) => entry.by_executor.every((row) => typeof row.label === "string")));
      assert.ok(payload.correlations.every((entry) => entry.by_executor.every((row) => typeof row.count === "number")));
      assert.ok(payload.correlations.every((entry) => entry.by_executor.every((row) => typeof row.percent === "number")));

      assert.ok(
        !payload.correlations.some((entry) => entry.fingerprint === "legacy_failure"),
      );
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("enforces date window filtering for stale errors and stale metric profiles", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      const now = Date.now();
      const recentTs = new Date(now - DAY_MS).toISOString();
      const staleTs = new Date(now - DAY_MS * 10).toISOString();

      const metrics = [
        JSON.stringify({
          timestamp: staleTs,
          attempt_id: "attempt-stale-m1",
          task_id: "task-window",
          task_title: "[l] stale task profile",
          task_description: "stale profile should be ignored",
          executor: "codex",
          model: "gpt-5.2-codex",
          metrics: { duration_ms: 1000 },
          outcome: { status: "failed" },
        }),
      ];

      const errors = [
        JSON.stringify({
          timestamp: recentTs,
          attempt_id: "attempt-window-1",
          task_id: "task-window",
          data: {
            error_fingerprint: "window_fp",
            error_message: "Windowed error",
            error_category: "runtime",
          },
        }),
        JSON.stringify({
          timestamp: staleTs,
          attempt_id: "attempt-window-old",
          task_id: "task-window",
          data: {
            error_fingerprint: "stale_fp",
            error_message: "Out of window",
            error_category: "runtime",
          },
        }),
      ];

      await writeLogFixtures(sandbox, {
        metricsLines: metrics,
        errorLines: errors,
      });

      const result = runAnalyticsCli(sandbox, [
        "--error-correlation",
        "--days",
        "7",
        "--top",
        "5",
        "--json",
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = parseJsonStdout(result);
      assert.equal(payload.total_errors, 1);
      assert.equal(payload.total_fingerprints, 1);
      assert.equal(payload.correlations[0].fingerprint, "window_fp");
      assert.equal(payload.correlations[0].by_executor[0].label, "unknown");
      assert.ok(
        !payload.correlations.some((entry) => entry.fingerprint === "stale_fp"),
      );
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("ignores malformed JSONL lines while preserving valid aggregate counts", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      await writeLogFixtures(sandbox, { includeMalformedErrorLine: true });

      const result = runAnalyticsCli(sandbox, [
        "--error-correlation",
        "--days",
        "7",
        "--top",
        "3",
        "--json",
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = parseJsonStdout(result);
      assert.equal(payload.total_errors, 5);
      assert.equal(payload.total_fingerprints, 3);
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("returns empty JSON contract when error logs are missing", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      await writeLogFixtures(sandbox, { omitErrorsLog: true });

      const result = runAnalyticsCli(sandbox, [
        "--error-correlation",
        "--days",
        "7",
        "--top",
        "3",
        "--json",
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = parseJsonStdout(result);

      assert.equal(payload.message, "No error data found");
      assert.equal(payload.window_days, 7);
      assert.equal(payload.total_errors, 0);
      assert.equal(payload.total_fingerprints, 0);
      assert.deepEqual(payload.correlations, []);
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("prints top clustered fingerprints and excludes stale entries in text mode", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      await writeLogFixtures(sandbox);

      const result = runAnalyticsCli(sandbox, [
        "--error-clustering",
        "--days",
        "7",
        "--top",
        "2",
      ]);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /timeout_api/);
      assert.match(result.stdout, /Occurrences: 2/);
      assert.doesNotMatch(result.stdout, /legacy_failure/);
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });
});

describe("analyze-agent-work testable helper exports", () => {
  it("exposes pure helper functions for unit-level clustering and correlation checks", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      const script = `
        import * as analytics from "./analyze-agent-work.mjs";

        const helpers = analytics.__testables;
        if (!helpers || typeof helpers !== "object") {
          throw new Error("missing __testables export");
        }

        const requiredFns = [
          "filterByDaysWindow",
          "buildErrorClusters",
          "buildErrorCorrelations",
        ];
        for (const fnName of requiredFns) {
          if (typeof helpers[fnName] !== "function") {
            throw new Error("missing helper: " + fnName);
          }
        }

        const now = new Date("2026-02-25T00:00:00.000Z");
        const errors = [
          {
            timestamp: "2026-02-24T00:00:00.000Z",
            task_id: "task-1",
            executor: "codex",
            data: { error_fingerprint: "timeout_api", error_message: "Timeout" },
          },
          {
            timestamp: "2026-02-24T00:01:00.000Z",
            task_id: "task-1",
            executor: "codex",
            data: { error_message: "Unhandled 500 at /jobs/1" },
          },
          {
            timestamp: "2026-02-24T00:02:00.000Z",
            task_id: "task-1",
            executor: "codex",
            data: { error_message: "Unhandled 501 at /jobs/2" },
          },
        ];
        const metrics = [
          {
            timestamp: "2026-02-24T00:00:00.000Z",
            task_id: "task-1",
            task_title: "[m] Retry improvements",
            task_description: "Improve retries",
            executor: "codex",
            model: "gpt-5.2-codex",
          },
        ];

        const clusters = helpers.buildErrorClusters(errors, { now, days: 7, top: 2 });
        const correlations = helpers.buildErrorCorrelations({
          errors,
          metrics,
          now,
          days: 7,
          top: 2,
        });

        console.log(
          JSON.stringify({
            clusterCount: clusters.length,
            firstCluster: clusters[0]?.fingerprint ?? null,
            correlationCount: correlations.correlations?.length ?? 0,
            firstExecutor:
              correlations.correlations?.[0]?.by_executor?.[0]?.label ?? null,
          }),
        );
      `;

      const result = runInlineModuleScript(sandbox, script);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = parseJsonStdout(result);

      assert.equal(output.clusterCount, 2);
      assert.equal(output.firstCluster, "unhandled # at /jobs/#");
      assert.equal(output.correlationCount, 2);
      assert.equal(output.firstExecutor, "codex");
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("keeps top-N ranking deterministic for equal-count fingerprints", async () => {
    const sandbox = await createAnalyticsSandbox();
    try {
      const script = `
        import * as analytics from "./analyze-agent-work.mjs";
        const helpers = analytics.__testables;

        const now = new Date("2026-02-25T00:00:00.000Z");
        const errors = [
          {
            timestamp: "2026-02-24T00:00:00.000Z",
            task_id: "task-1",
            data: { error_fingerprint: "fp-b", error_message: "B" },
          },
          {
            timestamp: "2026-02-24T00:01:00.000Z",
            task_id: "task-1",
            data: { error_fingerprint: "fp-a", error_message: "A" },
          },
          {
            timestamp: "2026-02-24T00:02:00.000Z",
            task_id: "task-1",
            data: { error_fingerprint: "fp-b", error_message: "B" },
          },
          {
            timestamp: "2026-02-24T00:03:00.000Z",
            task_id: "task-1",
            data: { error_fingerprint: "fp-a", error_message: "A" },
          },
        ];

        if (!helpers || typeof helpers.buildErrorClusters !== "function") {
          throw new Error("missing buildErrorClusters helper");
        }

        const ranked = helpers.buildErrorClusters(errors, { now, days: 7, top: 2 });
        console.log(JSON.stringify(ranked.map((row) => row.fingerprint)));
      `;

      const result = runInlineModuleScript(sandbox, script);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const ranking = parseJsonStdout(result);

      assert.deepEqual(ranking, ["fp-b", "fp-a"]);
    } finally {
      await rm(sandbox.sandboxRoot, { recursive: true, force: true });
    }
  });
});
