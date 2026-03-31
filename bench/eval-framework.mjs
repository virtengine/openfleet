import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TASK_TYPES = Object.freeze([
  "code-generation",
  "bug-fix",
  "refactor",
  "test-writing",
  "code-review",
]);

const BUILTIN_TASK_METRICS = Object.freeze({
  "code-generation": ["TaskSuccess", "TokenEfficiency", "TimeToComplete", "ContextUtilization"],
  "bug-fix": ["TaskSuccess", "TokenEfficiency", "TimeToComplete", "TestPassRate"],
  refactor: ["TaskSuccess", "TokenEfficiency", "TimeToComplete", "FalsePositiveRate"],
  "test-writing": ["TaskSuccess", "TokenEfficiency", "TimeToComplete", "TestPassRate"],
  "code-review": ["TaskSuccess", "TokenEfficiency", "TimeToComplete", "FalsePositiveRate"],
});

const BUILTIN_METRICS = Object.freeze([
  "TaskSuccess",
  "TokenEfficiency",
  "TimeToComplete",
  "TestPassRate",
  "FalsePositiveRate",
  "ContextUtilization",
]);

const DEFAULT_RESULTS_DIR = ".cache/eval-results";
const DEFAULT_BENCHMARKS_DIR = "bench/benchmarks";

function mean(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function percentile(values = [], p = 95) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.map((value) => Number(value || 0)).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTaskType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (TASK_TYPES.includes(normalized)) return normalized;
  return "code-generation";
}

function defaultMetricsForTask(type) {
  return [...(BUILTIN_TASK_METRICS[normalizeTaskType(type)] || BUILTIN_METRICS)];
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(resolve(filePath), "utf8"));
}

function dedupeStrings(values = []) {
  const output = [];
  for (const value of ensureArray(values)) {
    const normalized = String(value || "").trim();
    if (!normalized || output.includes(normalized)) continue;
    output.push(normalized);
  }
  return output;
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalCdf(value) {
  const x = Number(value || 0);
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * abs);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t) + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(abs * abs));
  return 0.5 * (1 + sign * erf);
}

function zScoreToPValue(score) {
  const normalized = Math.abs(Number(score || 0));
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(normalized))));
}

function computeSignificance(baseValues = [], candidateValues = []) {
  const baseline = ensureArray(baseValues).map((value) => toNumber(value)).filter((value) => Number.isFinite(value));
  const candidate = ensureArray(candidateValues).map((value) => toNumber(value)).filter((value) => Number.isFinite(value));
  if (baseline.length === 0 || candidate.length === 0) {
    return { score: 0, pValue: 1, method: "insufficient-data" };
  }
  const baselineMean = mean(baseline);
  const candidateMean = mean(candidate);
  const baselineVariance = mean(baseline.map((value) => (value - baselineMean) ** 2));
  const candidateVariance = mean(candidate.map((value) => (value - candidateMean) ** 2));
  const denominator = Math.sqrt(
    (baselineVariance / Math.max(1, baseline.length)) +
    (candidateVariance / Math.max(1, candidate.length)),
  );
  if (!Number.isFinite(denominator) || denominator === 0) {
    return {
      score: candidateMean === baselineMean ? 0 : Number.POSITIVE_INFINITY,
      pValue: candidateMean === baselineMean ? 1 : 0,
      method: "welch-z",
    };
  }
  const score = (candidateMean - baselineMean) / denominator;
  return {
    score,
    pValue: zScoreToPValue(score),
    method: "welch-z",
  };
}

function normalizeMetricName(value) {
  return String(value || "").trim();
}

function calculateCostFromOutcome(outcome = {}, strategy = {}) {
  const totalTokens = toNumber(outcome.totalTokens, toNumber(outcome.tokensInput) + toNumber(outcome.tokensOutput));
  const rate = toNumber(
    strategy.costPerMillionTokens ?? strategy.costRatePerMillion ?? strategy.tokenCostPerMillion,
    0,
  );
  if (!rate || totalTokens <= 0) return 0;
  return (totalTokens / 1_000_000) * rate;
}

export class Task {
  constructor(raw = {}) {
    this.id = String(raw.id || "").trim() || `task-${randomUUID()}`;
    this.type = normalizeTaskType(raw.type);
    this.input = raw.input && typeof raw.input === "object" ? { ...raw.input } : { prompt: "", repoState: {} };
    this.groundTruth = raw.groundTruth && typeof raw.groundTruth === "object" ? { ...raw.groundTruth } : {};
    this.metrics = ensureArray(raw.metrics).length > 0
      ? dedupeStrings(ensureArray(raw.metrics).map((metric) => normalizeMetricName(metric)))
      : defaultMetricsForTask(this.type);
    this.tags = raw.tags && typeof raw.tags === "object" && !Array.isArray(raw.tags) ? { ...raw.tags } : {};
  }
}

export class Benchmark {
  constructor(raw = {}) {
    this.id = String(raw.id || raw.name || "benchmark").trim() || "benchmark";
    this.name = String(raw.name || raw.id || "benchmark").trim() || "benchmark";
    this.description = String(raw.description || "").trim();
    this.tasks = ensureArray(raw.tasks).map((task) => task instanceof Task ? task : new Task(task));
    this.tags = raw.tags && typeof raw.tags === "object" && !Array.isArray(raw.tags) ? { ...raw.tags } : {};
    this.sourcePath = String(raw.sourcePath || "").trim();
  }
}

export class Metric {
  constructor(name, evaluator, options = {}) {
    this.name = normalizeMetricName(name);
    this.evaluator = typeof evaluator === "function" ? evaluator : (() => null);
    this.kind = String(options.kind || "metric");
    this.description = String(options.description || "").trim();
  }

  evaluate(context) {
    return this.evaluator(context);
  }
}

export class CategoryMetric extends Metric {
  constructor(name, evaluator, options = {}) {
    super(name, evaluator, { ...options, kind: "category" });
  }
}

export class NumericalMetric extends Metric {
  constructor(name, evaluator, options = {}) {
    super(name, evaluator, { ...options, kind: "numerical" });
  }
}

function defaultRunner() {
  return async () => ({
    success: false,
    durationMs: 0,
    tokensInput: 0,
    tokensOutput: 0,
    filesChanged: 0,
    testsPassed: 0,
    testsTotal: 0,
    falsePositives: 0,
    contextBytes: 0,
    contextBudgetBytes: 0,
    costUsd: 0,
  });
}

export function builtInMetricInstances() {
  return [
    new CategoryMetric("TaskSuccess", ({ outcome }) => outcome.success ? "pass" : "fail"),
    new NumericalMetric("TokenEfficiency", ({ outcome }) => {
      const totalTokens = toNumber(outcome.totalTokens, toNumber(outcome.tokensInput) + toNumber(outcome.tokensOutput));
      return totalTokens / Math.max(1, toNumber(outcome.filesChanged, 1));
    }),
    new NumericalMetric("TimeToComplete", ({ outcome }) => toNumber(outcome.durationMs)),
    new NumericalMetric("TestPassRate", ({ outcome }) => {
      const total = Math.max(0, toNumber(outcome.testsTotal));
      if (total === 0) return outcome.success ? 1 : 0;
      return toNumber(outcome.testsPassed) / total;
    }),
    new NumericalMetric("FalsePositiveRate", ({ outcome }) => {
      const reviewedCount = Math.max(1, toNumber(outcome.findingsTotal, toNumber(outcome.filesChanged, 1)));
      return toNumber(outcome.falsePositives) / reviewedCount;
    }),
    new NumericalMetric("ContextUtilization", ({ outcome }) => {
      const budget = Math.max(0, toNumber(outcome.contextBudgetBytes));
      if (budget === 0) return 0;
      return toNumber(outcome.contextBytes) / budget;
    }),
  ];
}

function mapMetrics(metrics = []) {
  const metricMap = new Map();
  for (const metric of [...builtInMetricInstances(), ...metrics]) {
    if (!metric?.name) continue;
    metricMap.set(metric.name, metric);
  }
  return metricMap;
}

function buildTaskSummaryEntries(results = []) {
  const byTask = new Map();
  for (const result of ensureArray(results)) {
    const taskId = String(result?.taskId || "").trim();
    if (!taskId) continue;
    if (!byTask.has(taskId)) {
      byTask.set(taskId, {
        taskId,
        taskType: result.taskType || "code-generation",
        repeats: 0,
        passCount: 0,
        tokenValues: [],
        timeValues: [],
        costValues: [],
        resultIndexes: [],
      });
    }
    const entry = byTask.get(taskId);
    entry.repeats += 1;
    if (result.metrics?.TaskSuccess === "pass") entry.passCount += 1;
    entry.tokenValues.push(toNumber(result.outcome?.totalTokens, toNumber(result.outcome?.tokensInput) + toNumber(result.outcome?.tokensOutput)));
    entry.timeValues.push(toNumber(result.outcome?.durationMs));
    entry.costValues.push(toNumber(result.outcome?.costUsd));
    entry.resultIndexes.push(result.resultIndex);
  }
  return [...byTask.values()].map((entry) => ({
    taskId: entry.taskId,
    taskType: entry.taskType,
    repeats: entry.repeats,
    passRate: entry.repeats > 0 ? entry.passCount / entry.repeats : 0,
    avgTokens: mean(entry.tokenValues),
    avgTimeMs: mean(entry.timeValues),
    avgCostUsd: mean(entry.costValues),
  }));
}

function summarizeRun(run) {
  const results = ensureArray(run.results);
  const timeValues = [];
  const tokenValues = [];
  const costValues = [];
  let passCount = 0;
  for (const result of results) {
    const metrics = result.metrics || {};
    const totalTokens = toNumber(result.outcome?.totalTokens, toNumber(result.outcome?.tokensInput) + toNumber(result.outcome?.tokensOutput));
    const totalCost = toNumber(result.outcome?.costUsd);
    if (metrics.TaskSuccess === "pass") passCount += 1;
    timeValues.push(toNumber(metrics.TimeToComplete, result.outcome?.durationMs));
    tokenValues.push(totalTokens);
    costValues.push(totalCost);
  }
  return {
    totalTasks: results.length,
    passRate: results.length > 0 ? passCount / results.length : 0,
    avgTokens: mean(tokenValues),
    p95Tokens: percentile(tokenValues, 95),
    avgTimeMs: mean(timeValues),
    p95TimeMs: percentile(timeValues, 95),
    totalCostUsd: costValues.reduce((sum, value) => sum + value, 0),
    avgCostUsd: mean(costValues),
    perTask: buildTaskSummaryEntries(results),
  };
}

function normalizeStrategy(raw = {}, index = 0) {
  const strategy = raw && typeof raw === "object" ? { ...raw } : { id: String(raw || "") };
  const id = String(strategy.id || strategy.name || `strategy-${index + 1}`).trim() || `strategy-${index + 1}`;
  return {
    id,
    label: String(strategy.label || strategy.name || id).trim() || id,
    sdk: String(strategy.sdk || "").trim(),
    model: String(strategy.model || "").trim(),
    promptStrategy: String(strategy.promptStrategy || strategy.prompt || "").trim(),
    codebaseProfile: String(strategy.codebaseProfile || strategy.repoProfile || "").trim(),
    annotated: strategy.annotated === true,
    unannotated: strategy.unannotated === true,
    config: strategy.config && typeof strategy.config === "object" ? { ...strategy.config } : {},
    costPerMillionTokens: toNumber(strategy.costPerMillionTokens ?? strategy.costRatePerMillion, 0),
    metadata: strategy.metadata && typeof strategy.metadata === "object" ? { ...strategy.metadata } : {},
  };
}

function loadRunFromFile(runPath) {
  return parseJsonFile(runPath);
}

function readRunById(resultsDir, runId) {
  return loadRunFromFile(resolveEvalResultPath(resultsDir, runId));
}

export class Evaluator {
  constructor(options = {}) {
    this.resultsDir = resolve(options.resultsDir || DEFAULT_RESULTS_DIR);
    this.metrics = ensureArray(options.metrics);
    this.runner = options.runner || defaultRunner();
    this.parallelism = Math.max(1, toNumber(options.parallelism, 1));
    this.storageAdapter = options.storageAdapter || null;
  }

  async evaluate({ benchmark, repeats = 1, strategies = [] } = {}) {
    const normalizedBenchmark = benchmark instanceof Benchmark ? benchmark : new Benchmark(benchmark || {});
    const normalizedStrategies = ensureArray(strategies).length > 0
      ? ensureArray(strategies).map((strategy, index) => normalizeStrategy(strategy, index))
      : [normalizeStrategy({ id: "default", label: "Default" })];
    const metricMap = mapMetrics(this.metrics);
    const runId = `eval-${Date.now()}-${randomUUID()}`;
    const results = [];
    let resultIndex = 0;

    for (const strategy of normalizedStrategies) {
      for (const task of normalizedBenchmark.tasks) {
        for (let repeatIndex = 0; repeatIndex < Math.max(1, repeats); repeatIndex += 1) {
          const outcome = {
            ...(await this.runner({ benchmark: normalizedBenchmark, task, strategy, repeatIndex })),
          };
          outcome.totalTokens = toNumber(
            outcome.totalTokens,
            toNumber(outcome.tokensInput) + toNumber(outcome.tokensOutput),
          );
          outcome.costUsd = toNumber(
            outcome.costUsd,
            calculateCostFromOutcome(outcome, strategy),
          );
          const metricResults = {};
          for (const metricName of task.metrics) {
            const metric = metricMap.get(metricName);
            if (!metric) continue;
            metricResults[metricName] = metric.evaluate({
              benchmark: normalizedBenchmark,
              task,
              strategy,
              repeatIndex,
              outcome,
            });
          }
          results.push({
            resultIndex: resultIndex++,
            strategyId: strategy.id,
            strategyLabel: strategy.label,
            strategy,
            taskId: task.id,
            taskType: task.type,
            repeatIndex,
            metrics: metricResults,
            outcome,
          });
        }
      }
    }

    const summary = summarizeRun({ results });
    const run = {
      runId,
      benchmarkId: normalizedBenchmark.id,
      benchmark: normalizedBenchmark.name,
      benchmarkDescription: normalizedBenchmark.description,
      repeats: Math.max(1, repeats),
      strategyIds: normalizedStrategies.map((strategy) => strategy.id),
      strategies: normalizedStrategies,
      parallelism: this.parallelism,
      createdAt: new Date().toISOString(),
      results,
      summary,
    };

    mkdirSync(this.resultsDir, { recursive: true });
    const resultPath = resolve(this.resultsDir, `${runId}.json`);
    writeFileSync(resultPath, JSON.stringify(run, null, 2) + "\n", "utf8");
    if (this.storageAdapter && typeof this.storageAdapter.writeRun === "function") {
      await this.storageAdapter.writeRun(run, resultPath);
    }
    return { ...run, resultPath };
  }
}

export async function importBenchmarkFromFile(filePath) {
  const raw = parseJsonFile(filePath);
  return new Benchmark({ ...raw, sourcePath: resolve(filePath) });
}

export function compareEvaluationRuns(baseline, candidate) {
  const metricKeys = ["passRate", "avgTokens", "p95Tokens", "avgTimeMs", "p95TimeMs", "avgCostUsd", "totalCostUsd"];
  const metricDeltas = {};
  for (const key of metricKeys) {
    const baseValue = toNumber(baseline?.summary?.[key]);
    const candidateValue = toNumber(candidate?.summary?.[key]);
    const delta = candidateValue - baseValue;
    const baselineTaskValues = ensureArray(baseline?.summary?.perTask).map((entry) => toNumber(entry?.[key]));
    const candidateTaskValues = ensureArray(candidate?.summary?.perTask).map((entry) => toNumber(entry?.[key]));
    metricDeltas[key] = {
      baseline: baseValue,
      candidate: candidateValue,
      delta,
      significance: computeSignificance(baselineTaskValues, candidateTaskValues),
    };
  }

  const baselineMap = new Map(ensureArray(baseline?.summary?.perTask).map((entry) => [entry.taskId, entry]));
  const candidateMap = new Map(ensureArray(candidate?.summary?.perTask).map((entry) => [entry.taskId, entry]));
  const improved = [];
  const regressed = [];
  const unchanged = [];

  for (const [taskId, baselineResult] of baselineMap.entries()) {
    const candidateResult = candidateMap.get(taskId);
    if (!candidateResult) continue;
    const passDelta = toNumber(candidateResult.passRate) - toNumber(baselineResult.passRate);
    const tokenDelta = toNumber(candidateResult.avgTokens) - toNumber(baselineResult.avgTokens);
    const timeDelta = toNumber(candidateResult.avgTimeMs) - toNumber(baselineResult.avgTimeMs);
    const record = {
      taskId,
      baseline: baselineResult,
      candidate: candidateResult,
      passRateDelta: passDelta,
      avgTokensDelta: tokenDelta,
      avgTimeMsDelta: timeDelta,
    };
    if (passDelta > 0) improved.push(record);
    else if (passDelta < 0) regressed.push(record);
    else unchanged.push(record);
  }

  return {
    baselineRunId: baseline?.runId || "",
    candidateRunId: candidate?.runId || "",
    metricDeltas,
    perTask: { improved, regressed, unchanged },
  };
}

export function summarizeMatrix(runs = []) {
  const rows = ensureArray(runs).map((run) => ({
    config: ensureArray(run.strategyIds)[0] || run.strategyId || "default",
    passRate: toNumber(run.summary?.passRate),
    avgTokens: toNumber(run.summary?.avgTokens),
    p95Tokens: toNumber(run.summary?.p95Tokens),
    avgTimeMs: toNumber(run.summary?.avgTimeMs),
    p95TimeMs: toNumber(run.summary?.p95TimeMs),
    cost: toNumber(run.summary?.totalCostUsd, toNumber(run.summary?.avgCostUsd)),
  }));
  return { rows };
}

export function compareAuditImpactRuns(withAnnotations, withoutAnnotations) {
  const comparison = compareEvaluationRuns(withoutAnnotations, withAnnotations);
  const rows = [
    ["Pass Rate", withAnnotations?.summary?.passRate, withoutAnnotations?.summary?.passRate],
    ["Avg Tokens", withAnnotations?.summary?.avgTokens, withoutAnnotations?.summary?.avgTokens],
    ["Avg Time (ms)", withAnnotations?.summary?.avgTimeMs, withoutAnnotations?.summary?.avgTimeMs],
    ["False Positive Rate", mean(ensureArray(withAnnotations?.results).map((entry) => toNumber(entry?.metrics?.FalsePositiveRate))), mean(ensureArray(withoutAnnotations?.results).map((entry) => toNumber(entry?.metrics?.FalsePositiveRate)))],
  ].map(([metric, withValue, withoutValue]) => ({
    metric,
    withAnnotations: toNumber(withValue),
    withoutAnnotations: toNumber(withoutValue),
    delta: toNumber(withValue) - toNumber(withoutValue),
  }));
  return {
    comparison,
    rows,
  };
}

export function resolveEvalResultPath(resultsDir, runId) {
  return resolve(resultsDir || DEFAULT_RESULTS_DIR, `${basename(String(runId || "").replace(/\.json$/i, ""))}.json`);
}

export function listStoredEvaluationRuns(resultsDir = DEFAULT_RESULTS_DIR) {
  const dir = resolve(resultsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("eval-") && name.endsWith(".json"))
    .sort()
    .map((name) => ({
      runId: name.replace(/\.json$/i, ""),
      path: resolve(dir, name),
    }));
}

export function detectRegression(currentRun, baselineRun, thresholds = {}) {
  const maxTokenRegression = toNumber(thresholds.maxTokenRegression, Infinity);
  const minPassRate = thresholds.minPassRate == null ? -Infinity : toNumber(thresholds.minPassRate);
  const tokenRegression = toNumber(currentRun?.summary?.avgTokens) - toNumber(baselineRun?.summary?.avgTokens);
  const tokenRegressionRatio = toNumber(baselineRun?.summary?.avgTokens) === 0
    ? (tokenRegression > 0 ? Infinity : 0)
    : tokenRegression / Math.max(1e-9, toNumber(baselineRun?.summary?.avgTokens));
  const passRate = toNumber(currentRun?.summary?.passRate);
  const failures = [];
  if (Number.isFinite(maxTokenRegression) && tokenRegressionRatio > maxTokenRegression) {
    failures.push({
      metric: "avgTokens",
      actual: tokenRegressionRatio,
      threshold: maxTokenRegression,
      message: `Average token regression ${tokenRegressionRatio.toFixed(4)} exceeds ${maxTokenRegression.toFixed(4)}`,
    });
  }
  if (passRate < minPassRate) {
    failures.push({
      metric: "passRate",
      actual: passRate,
      threshold: minPassRate,
      message: `Pass rate ${passRate.toFixed(4)} is below ${minPassRate.toFixed(4)}`,
    });
  }
  return {
    ok: failures.length === 0,
    failures,
  };
}

export function summarizeHistory(runs = []) {
  const ordered = ensureArray(runs)
    .map((run) => ({
      runId: run.runId,
      createdAt: run.createdAt || "",
      benchmark: run.benchmark || run.benchmarkId || "",
      passRate: toNumber(run.summary?.passRate),
      avgTokens: toNumber(run.summary?.avgTokens),
      avgTimeMs: toNumber(run.summary?.avgTimeMs),
      totalCostUsd: toNumber(run.summary?.totalCostUsd),
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const regressions = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.passRate < previous.passRate || current.avgTokens > previous.avgTokens) {
      regressions.push({
        fromRunId: previous.runId,
        toRunId: current.runId,
        passRateDelta: current.passRate - previous.passRate,
        avgTokensDelta: current.avgTokens - previous.avgTokens,
      });
    }
  }
  return { runs: ordered, regressions };
}

function renderMatrixTable(rows = []) {
  const header = ["Config", "Pass Rate", "Avg Tokens", "Avg Time", "Cost"];
  const tableRows = ensureArray(rows).map((row) => [
    row.config,
    `${(toNumber(row.passRate) * 100).toFixed(1)}%`,
    Math.round(toNumber(row.avgTokens)).toString(),
    `${(toNumber(row.avgTimeMs) / 1000).toFixed(1)}s`,
    `$${toNumber(row.cost).toFixed(4)}`,
  ]);
  return [header, ...tableRows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

function printUsage() {
  console.log(`Bosun evaluation framework\n\nUsage:\n  bosun eval import <tasks.json>\n  bosun eval run --benchmark <file|name> [--repeats N] [--config id] [--results-dir dir]\n  bosun eval compare <run1.json|run1> <run2.json|run2> [--results-dir dir]\n  bosun eval matrix --benchmark <file|name> [--repeats N] [--configs a,b] [--results-dir dir]\n  bosun eval audit-impact --with <run|file> --without <run|file> [--results-dir dir]\n  bosun eval ci --baseline <run|file> --candidate <run|file> [--max-token-regression 0.10] [--min-pass-rate 0.85]\n  bosun eval history [--results-dir dir]\n`);
}

function getArgValue(args, flag) {
  const inline = args.find((entry) => entry.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function parseConfigList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveBenchmarkPath(input = "", options = {}) {
  const value = String(input || "").trim();
  if (!value) return "";
  if (existsSync(resolve(value))) return resolve(value);
  const benchmarksDir = resolve(options.benchmarksDir || DEFAULT_BENCHMARKS_DIR);
  const candidates = [
    resolve(benchmarksDir, value),
    resolve(benchmarksDir, `${value}.json`),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || resolve(value);
}

function resolveRunInput(input, resultsDir) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Run identifier is required");
  if (existsSync(resolve(value))) return loadRunFromFile(resolve(value));
  return readRunById(resultsDir, value);
}

function createSyntheticRunner() {
  return async ({ task, strategy, repeatIndex }) => {
    const promptLength = String(task?.input?.prompt || "").length;
    const taskWeight = TASK_TYPES.indexOf(task?.type) + 1;
    const strategyWeight = Math.max(1, String(strategy?.id || "default").length % 7);
    const success = !String(strategy?.id || "").toLowerCase().includes("fail");
    return {
      success,
      durationMs: 1000 + (repeatIndex * 125) + (taskWeight * 200) + (strategyWeight * 50),
      tokensInput: 800 + promptLength + (taskWeight * 75),
      tokensOutput: 300 + (repeatIndex * 20) + (strategyWeight * 15),
      filesChanged: Math.max(1, taskWeight - 1),
      testsPassed: success ? Math.max(1, taskWeight) : Math.max(0, taskWeight - 1),
      testsTotal: Math.max(1, taskWeight),
      falsePositives: task?.type === "code-review" && success ? 0 : (task?.type === "code-review" ? 1 : 0),
      contextBytes: 2048 + promptLength,
      contextBudgetBytes: 8192,
    };
  };
}

export async function runEvalCli(args = []) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return { exitCode: 0 };
  }

  if (command === "import") {
    const filePath = rest[0];
    if (!filePath) {
      console.error("Usage: bosun eval import <tasks.json>");
      return { exitCode: 1 };
    }
    const benchmark = await importBenchmarkFromFile(filePath);
    console.log(`Imported benchmark ${benchmark.name}: tasks=${benchmark.tasks.length}`);
    return { exitCode: 0, benchmark };
  }

  if (command === "run") {
    const resultsDir = getArgValue(rest, "--results-dir") || DEFAULT_RESULTS_DIR;
    const benchmarkPath = resolveBenchmarkPath(getArgValue(rest, "--benchmark"), {
      benchmarksDir: getArgValue(rest, "--benchmarks-dir") || DEFAULT_BENCHMARKS_DIR,
    });
    const repeats = Math.max(1, toNumber(getArgValue(rest, "--repeats"), 1));
    const configId = getArgValue(rest, "--config") || "default";
    if (!benchmarkPath) {
      console.error("Usage: bosun eval run --benchmark <file|name> [--repeats N] [--config id]");
      return { exitCode: 1 };
    }
    const benchmark = await importBenchmarkFromFile(benchmarkPath);
    const evaluator = new Evaluator({ resultsDir, runner: createSyntheticRunner() });
    const run = await evaluator.evaluate({
      benchmark,
      repeats,
      strategies: [{ id: configId, label: configId }],
    });
    console.log(JSON.stringify({ runId: run.runId, resultPath: run.resultPath, summary: run.summary }, null, 2));
    return { exitCode: 0, run };
  }

  if (command === "compare") {
    const resultsDir = getArgValue(rest, "--results-dir") || DEFAULT_RESULTS_DIR;
    const [runAPath, runBPath] = rest.filter((entry) => !/^--/.test(entry));
    if (!runAPath || !runBPath) {
      console.error("Usage: bosun eval compare <run1.json|run1> <run2.json|run2>");
      return { exitCode: 1 };
    }
    const baseline = resolveRunInput(runAPath, resultsDir);
    const candidate = resolveRunInput(runBPath, resultsDir);
    const comparison = compareEvaluationRuns(baseline, candidate);
    console.log(JSON.stringify(comparison, null, 2));
    return { exitCode: 0, comparison };
  }

  if (command === "matrix") {
    const resultsDir = getArgValue(rest, "--results-dir") || DEFAULT_RESULTS_DIR;
    const benchmarkPath = resolveBenchmarkPath(getArgValue(rest, "--benchmark"), {
      benchmarksDir: getArgValue(rest, "--benchmarks-dir") || DEFAULT_BENCHMARKS_DIR,
    });
    const repeats = Math.max(1, toNumber(getArgValue(rest, "--repeats"), 1));
    const configs = parseConfigList(getArgValue(rest, "--configs") || "default");
    if (!benchmarkPath) {
      console.error("Usage: bosun eval matrix --benchmark <file|name> [--repeats N] [--configs a,b]");
      return { exitCode: 1 };
    }
    const benchmark = await importBenchmarkFromFile(benchmarkPath);
    const evaluator = new Evaluator({ resultsDir, runner: createSyntheticRunner() });
    const runs = [];
    for (const configId of configs) {
      const run = await evaluator.evaluate({
        benchmark,
        repeats,
        strategies: [{ id: configId, label: configId }],
      });
      runs.push(run);
    }
    const matrix = summarizeMatrix(runs);
    console.log(renderMatrixTable(matrix.rows));
    return { exitCode: 0, runs, matrix };
  }

  if (command === "audit-impact") {
    const resultsDir = getArgValue(rest, "--results-dir") || DEFAULT_RESULTS_DIR;
    const withInput = getArgValue(rest, "--with");
    const withoutInput = getArgValue(rest, "--without");
    if (!withInput || !withoutInput) {
      console.error("Usage: bosun eval audit-impact --with <run|file> --without <run|file>");
      return { exitCode: 1 };
    }
    const withAnnotations = resolveRunInput(withInput, resultsDir);
    const withoutAnnotations = resolveRunInput(withoutInput, resultsDir);
    const impact = compareAuditImpactRuns(withAnnotations, withoutAnnotations);
    console.log(JSON.stringify(impact, null, 2));
    return { exitCode: 0, impact };
  }

  if (command === "ci") {
    const resultsDir = getArgValue(rest, "--results-dir") || DEFAULT_RESULTS_DIR;
    const baselineInput = getArgValue(rest, "--baseline");
    const candidateInput = getArgValue(rest, "--candidate");
    if (!baselineInput || !candidateInput) {
      console.error("Usage: bosun eval ci --baseline <run|file> --candidate <run|file>");
      return { exitCode: 1 };
    }
    const baseline = resolveRunInput(baselineInput, resultsDir);
    const candidate = resolveRunInput(candidateInput, resultsDir);
    const regression = detectRegression(candidate, baseline, {
      maxTokenRegression: toNumber(getArgValue(rest, "--max-token-regression"), 0.1),
      minPassRate: toNumber(getArgValue(rest, "--min-pass-rate"), 0.85),
    });
    if (!regression.ok) {
      console.error(JSON.stringify(regression, null, 2));
      return { exitCode: 1, regression };
    }
    console.log(JSON.stringify(regression, null, 2));
    return { exitCode: 0, regression };
  }

  if (command === "history") {
    const resultsDir = getArgValue(rest, "--results-dir") || DEFAULT_RESULTS_DIR;
    const runs = listStoredEvaluationRuns(resultsDir).map((entry) => loadRunFromFile(entry.path));
    const history = summarizeHistory(runs);
    console.log(JSON.stringify(history, null, 2));
    return { exitCode: 0, history };
  }

  console.error(`Unknown eval command: ${command}`);
  printUsage();
  return { exitCode: 1 };
}
