import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  Benchmark,
  CategoryMetric,
  Evaluator,
  NumericalMetric,
  Task,
  compareAuditImpactRuns,
  compareEvaluationRuns,
  detectRegression,
  importBenchmarkFromFile,
  listStoredEvaluationRuns,
  runEvalCli,
  summarizeHistory,
  summarizeMatrix,
} from "../bench/eval-framework.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("eval framework", () => {
  it("imports benchmark tasks from json and normalizes built-in task metadata", async () => {
    const dir = makeTempDir("bosun-eval-import-");
    const benchmarkPath = resolve(dir, "tasks.json");
    writeFileSync(
      benchmarkPath,
      JSON.stringify({
        name: "code-review-10",
        tasks: [
          {
            id: "review-1",
            type: "code-review",
            input: {
              prompt: "Review this diff",
              repoState: { ref: "main" },
            },
            groundTruth: {
              expectedFiles: ["src/app.mjs"],
              expectedTests: ["npm test"],
            },
            tags: { area: "server", difficulty: "easy" },
          },
        ],
      }),
      "utf8",
    );

    const benchmark = await importBenchmarkFromFile(benchmarkPath);

    expect(benchmark).toBeInstanceOf(Benchmark);
    expect(benchmark.name).toBe("code-review-10");
    expect(benchmark.tasks).toHaveLength(1);
    expect(benchmark.tasks[0]).toBeInstanceOf(Task);
    expect(benchmark.tasks[0].type).toBe("code-review");
    expect(benchmark.tasks[0].metrics).toEqual(expect.arrayContaining(["TaskSuccess", "FalsePositiveRate"]));
    expect(benchmark.tasks[0].tags).toEqual({ area: "server", difficulty: "easy" });
  });

  it("evaluates repeated runs, persists json results, and summarizes a matrix", async () => {
    const dir = makeTempDir("bosun-eval-run-");
    const benchmark = new Benchmark({
      name: "mini-suite",
      tasks: [
        new Task({
          id: "bug-1",
          type: "bug-fix",
          input: { prompt: "Fix the parser", repoState: { ref: "abc123" } },
          groundTruth: { expectedFiles: ["src/parser.mjs"] },
        }),
      ],
    });

    const evaluator = new Evaluator({
      resultsDir: dir,
      metrics: [
        new CategoryMetric("TaskSuccess", ({ outcome }) => outcome.success ? "pass" : "fail"),
        new NumericalMetric("TokenEfficiency", ({ outcome }) => outcome.tokensInput / Math.max(outcome.filesChanged, 1)),
        new NumericalMetric("TimeToComplete", ({ outcome }) => outcome.durationMs),
      ],
      runner: async ({ repeatIndex, strategy }) => ({
        success: strategy.id === "codex-default",
        durationMs: 1000 + (repeatIndex * 100),
        tokensInput: 1200 + (repeatIndex * 100),
        filesChanged: 2,
      }),
    });

    const run = await evaluator.evaluate({
      benchmark,
      repeats: 3,
      strategies: [{ id: "codex-default", label: "Codex Default" }],
    });

    expect(run.summary.totalTasks).toBe(3);
    expect(run.summary.passRate).toBe(1);
    expect(run.summary.avgTimeMs).toBeCloseTo(1100);
    expect(run.summary.perTask).toHaveLength(1);
    expect(existsSync(run.resultPath)).toBe(true);

    const persisted = JSON.parse(readFileSync(run.resultPath, "utf8"));
    expect(persisted.runId).toBe(run.runId);
    expect(persisted.results).toHaveLength(3);

    const matrix = summarizeMatrix([run]);
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]).toMatchObject({
      config: "codex-default",
      passRate: 1,
    });
  });

  it("compares two runs with deltas and per-task regressions", () => {
    const baseline = {
      runId: "run-a",
      summary: {
        passRate: 0.5,
        avgTokens: 5000,
        p95Tokens: 8000,
        avgTimeMs: 60000,
        p95TimeMs: 90000,
        perTask: [
          { taskId: "task-1", passRate: 1, avgTokens: 4000, avgTimeMs: 55000 },
          { taskId: "task-2", passRate: 0, avgTokens: 6000, avgTimeMs: 65000 },
        ],
      },
      results: [
        { taskId: "task-1", metrics: { TaskSuccess: "pass", TokenEfficiency: 4000, TimeToComplete: 55000 } },
        { taskId: "task-2", metrics: { TaskSuccess: "fail", TokenEfficiency: 6000, TimeToComplete: 65000 } },
      ],
    };
    const candidate = {
      runId: "run-b",
      summary: {
        passRate: 1,
        avgTokens: 4200,
        p95Tokens: 7000,
        avgTimeMs: 45000,
        p95TimeMs: 70000,
        perTask: [
          { taskId: "task-1", passRate: 1, avgTokens: 3800, avgTimeMs: 43000 },
          { taskId: "task-2", passRate: 1, avgTokens: 4600, avgTimeMs: 47000 },
        ],
      },
      results: [
        { taskId: "task-1", metrics: { TaskSuccess: "pass", TokenEfficiency: 3800, TimeToComplete: 43000 } },
        { taskId: "task-2", metrics: { TaskSuccess: "pass", TokenEfficiency: 4600, TimeToComplete: 47000 } },
      ],
    };

    const comparison = compareEvaluationRuns(baseline, candidate);

    expect(comparison.metricDeltas.passRate.delta).toBeCloseTo(0.5);
    expect(comparison.metricDeltas.avgTokens.delta).toBeCloseTo(-800);
    expect(comparison.perTask.improved.map((entry) => entry.taskId)).toContain("task-2");
    expect(comparison.perTask.regressed).toEqual([]);
    expect(comparison.metricDeltas.passRate.significance.pValue).toBeGreaterThanOrEqual(0);
    expect(comparison.metricDeltas.passRate.significance.pValue).toBeLessThanOrEqual(1);
  });

  it("supports audit impact, history, and ci regression helpers", () => {
    const withoutAnnotations = {
      runId: "without",
      createdAt: "2026-03-25T00:00:00.000Z",
      benchmark: "suite",
      summary: {
        passRate: 0.7,
        avgTokens: 1000,
        avgTimeMs: 5000,
        totalCostUsd: 0.03,
      },
      results: [{ metrics: { FalsePositiveRate: 0.2 } }],
    };
    const withAnnotations = {
      runId: "with",
      createdAt: "2026-03-26T00:00:00.000Z",
      benchmark: "suite",
      summary: {
        passRate: 0.9,
        avgTokens: 800,
        avgTimeMs: 4000,
        totalCostUsd: 0.02,
      },
      results: [{ metrics: { FalsePositiveRate: 0.05 } }],
    };

    const impact = compareAuditImpactRuns(withAnnotations, withoutAnnotations);
    expect(impact.rows.find((entry) => entry.metric === "Avg Tokens")?.delta).toBe(-200);

    const history = summarizeHistory([withAnnotations, withoutAnnotations]);
    expect(history.runs.map((entry) => entry.runId)).toEqual(["without", "with"]);

    const regression = detectRegression(withAnnotations, withoutAnnotations, {
      maxTokenRegression: 0.1,
      minPassRate: 0.85,
    });
    expect(regression.ok).toBe(true);

    const failingRegression = detectRegression(withoutAnnotations, withAnnotations, {
      maxTokenRegression: 0.1,
      minPassRate: 0.85,
    });
    expect(failingRegression.ok).toBe(false);
  });

  it("lists stored runs and supports eval cli matrix/history flows", async () => {
    const dir = makeTempDir("bosun-eval-cli-");
    const benchmarkPath = resolve(dir, "benchmark.json");
    writeFileSync(
      benchmarkPath,
      JSON.stringify({
        name: "mini-benchmark",
        tasks: [
          {
            id: "task-1",
            type: "code-generation",
            input: { prompt: "Create helper" },
          },
        ],
      }),
      "utf8",
    );

    const matrixResult = await runEvalCli([
      "matrix",
      "--benchmark", benchmarkPath,
      "--configs", "codex-default,copilot-sonnet",
      "--repeats", "2",
      "--results-dir", dir,
    ]);
    expect(matrixResult.exitCode).toBe(0);
    expect(matrixResult.matrix.rows).toHaveLength(2);

    const storedRuns = listStoredEvaluationRuns(dir);
    expect(storedRuns).toHaveLength(2);

    const historyResult = await runEvalCli([
      "history",
      "--results-dir", dir,
    ]);
    expect(historyResult.exitCode).toBe(0);
    expect(historyResult.history.runs).toHaveLength(2);
  });
});
