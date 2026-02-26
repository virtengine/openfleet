import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/analyze-agent-work");
const SCRIPT_PATH = resolve(process.cwd(), "analyze-agent-work.mjs");
const ANALYTICS_LOG_DIR = resolve(dirname(SCRIPT_PATH), "../..", ".cache/agent-work-logs");
const ERROR_LOG_PATH = resolve(ANALYTICS_LOG_DIR, "agent-errors.jsonl");
const METRICS_LOG_PATH = resolve(ANALYTICS_LOG_DIR, "agent-metrics.jsonl");
const STREAM_LOG_PATH = resolve(ANALYTICS_LOG_DIR, "agent-work-stream.jsonl");
const METRICS_FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "metrics.json"), "utf8"),
);
const ERRORS_FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "errors.json"), "utf8"),
);
const METRICS_EVENTS_FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "metrics-events.json"), "utf8"),
);
const ERROR_EVENTS_FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "error-events.json"), "utf8"),
);
const FIXED_NOW = new Date("2026-02-26T12:00:00.000Z");
let moduleImportNonce = 0;

function assertFunction(moduleNs, name) {
  assert.equal(
    typeof moduleNs[name],
    "function",
    `expected ${name} to be exported as a function`,
  );
  return moduleNs[name];
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function serializeJsonl(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function seedAnalyticsLogs(t, { errors, metrics, stream }) {
  await mkdir(ANALYTICS_LOG_DIR, { recursive: true });

  const snapshots = {
    errors: await readOptionalFile(ERROR_LOG_PATH),
    metrics: await readOptionalFile(METRICS_LOG_PATH),
    stream: await readOptionalFile(STREAM_LOG_PATH),
  };

  t.after(async () => {
    const restores = [
      { path: ERROR_LOG_PATH, content: snapshots.errors },
      { path: METRICS_LOG_PATH, content: snapshots.metrics },
      { path: STREAM_LOG_PATH, content: snapshots.stream },
    ];

    for (const restore of restores) {
      if (restore.content === null) {
        await rm(restore.path, { force: true });
      } else {
        await writeFile(restore.path, restore.content, "utf8");
      }
    }
  });

  await writeFile(ERROR_LOG_PATH, serializeJsonl(errors), "utf8");

  if (metrics === null) {
    await rm(METRICS_LOG_PATH, { force: true });
  } else {
    await writeFile(METRICS_LOG_PATH, serializeJsonl(metrics), "utf8");
  }

  if (stream === null) {
    await rm(STREAM_LOG_PATH, { force: true });
  } else {
    await writeFile(STREAM_LOG_PATH, serializeJsonl(stream), "utf8");
  }
}

async function loadAnalyzeAgentWorkModule() {
  const argvSnapshot = process.argv;
  const exitSnapshot = process.exit;
  const logSnapshot = console.log;
  const errorSnapshot = console.error;

  process.argv = ["node", "analyze-agent-work.mjs", "--weekly-report"];
  process.exit = ((code) => {
    throw new Error(`unexpected process.exit(${code}) while importing analyze-agent-work.mjs`);
  });
  console.log = () => {};
  console.error = () => {};

  try {
    const moduleUrl = new URL("../analyze-agent-work.mjs", import.meta.url);
    moduleImportNonce += 1;
    moduleUrl.searchParams.set("node_test", String(moduleImportNonce));
    return await import(moduleUrl.href);
  } finally {
    process.argv = argvSnapshot;
    process.exit = exitSnapshot;
    console.log = logSnapshot;
    console.error = errorSnapshot;
  }
}

test("exports pure analytics helpers for clustering/correlation testability", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  assertFunction(moduleNs, "normalizeTimestamp");
  assertFunction(moduleNs, "normalizeErrorFingerprint");
  assertFunction(moduleNs, "filterRecordsByWindow");
  assertFunction(moduleNs, "buildErrorClusters");
  assertFunction(moduleNs, "buildErrorCorrelationSummary");
  assertFunction(moduleNs, "buildErrorCorrelationJsonPayload");
  assertFunction(moduleNs, "buildErrorCorrelationPayload");
});

test("buildErrorClusters groups by fingerprint and enforces window + top-N", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorClusters = assertFunction(moduleNs, "buildErrorClusters");

  const clusters = buildErrorClusters(ERRORS_FIXTURE, {
    days: 7,
    top: 2,
    now: FIXED_NOW,
  });

  assert.equal(Array.isArray(clusters), true);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].fingerprint, "timeout_error");
  assert.equal(clusters[0].count, 3);
  assert.equal(clusters[0].affected_tasks, 2);
  assert.equal(clusters[1].fingerprint, "dependency_missing");
  assert.equal(clusters[1].count, 2);

  const fingerprints = clusters.map((cluster) => cluster.fingerprint);
  assert.equal(fingerprints.includes("auth failed for user #"), false);
});

test("buildErrorClusters derives fingerprints from messages when missing", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorClusters = assertFunction(moduleNs, "buildErrorClusters");

  const clusters = buildErrorClusters(
    [
      {
        timestamp: "2026-02-25T12:00:00.000Z",
        task_id: "T-1",
        attempt_id: "A-1",
        data: {
          error_message: "Auth failed for user 456",
          error_category: "auth",
        },
      },
    ],
    {
      days: 7,
      top: 10,
      now: FIXED_NOW,
    },
  );

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].sample_message, "Auth failed for user 456");
  assert.equal(clusters[0].fingerprint, "auth failed for user #");
  assert.deepEqual(clusters[0].categories, ["auth"]);
});

test("buildErrorCorrelationPayload returns stable JSON contract and distributions", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorCorrelationPayload = assertFunction(
    moduleNs,
    "buildErrorCorrelationPayload",
  );

  const payload = buildErrorCorrelationPayload({
    errors: ERRORS_FIXTURE,
    metrics: METRICS_FIXTURE,
    days: 7,
    top: 2,
    now: FIXED_NOW,
  });

  assert.equal(typeof payload, "object");
  assert.equal(payload.window_days, 7);
  assert.equal(payload.total_errors, 6);
  assert.equal(payload.total_fingerprints, 3);
  assert.equal(payload.top, 2);
  assert.equal(Array.isArray(payload.correlations), true);
  assert.equal(payload.correlations.length, 2);

  const first = payload.correlations[0];
  assert.equal(first.fingerprint, "timeout_error");
  assert.equal(first.count, 3);
  assert.equal(first.task_count, 2);
  assert.equal(Array.isArray(first.by_executor), true);
  assert.equal(Array.isArray(first.by_size), true);
  assert.equal(Array.isArray(first.by_complexity), true);
  assert.equal(first.by_executor.some((entry) => entry.label === "codex"), true);
});

test("buildErrorCorrelationPayload handles empty inputs safely", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorCorrelationPayload = assertFunction(
    moduleNs,
    "buildErrorCorrelationPayload",
  );

  const payload = buildErrorCorrelationPayload({
    errors: [],
    metrics: [],
    days: 7,
    top: 5,
    now: FIXED_NOW,
  });

  assert.equal(payload.window_days, 7);
  assert.equal(payload.total_errors, 0);
  assert.equal(payload.total_fingerprints, 0);
  assert.equal(payload.top, 5);
  assert.deepEqual(payload.correlations, []);
});

test("CLI --error-correlation --json emits parseable contract output", () => {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "--error-correlation",
      "--days",
      "7",
      "--top",
      "3",
      "--json",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const stdout = (result.stdout || "").trim();
  assert.notEqual(stdout.length, 0, "expected JSON output from CLI");

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    assert.fail(`unable to parse CLI JSON output: ${error.message}\n${stdout}`);
  }

  assert.equal(typeof parsed.window_days, "number");
  assert.equal(typeof parsed.total_errors, "number");
  assert.equal(typeof parsed.total_fingerprints, "number");
  assert.equal(Array.isArray(parsed.correlations), true);

  if (parsed.total_errors > 0) {
    assert.equal(typeof parsed.generated_at, "string");
    assert.equal(typeof parsed.top, "number");
    if (parsed.correlations.length > 0) {
      const first = parsed.correlations[0];
      assert.equal(typeof first.fingerprint, "string");
      assert.equal(typeof first.count, "number");
      assert.equal(Array.isArray(first.by_executor), true);
      assert.equal(Array.isArray(first.by_size), true);
      assert.equal(Array.isArray(first.by_complexity), true);
    }
  } else {
    assert.equal(parsed.correlations.length, 0);
  }
});

test("CLI --executor-comparison fails fast without executors", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--executor-comparison"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr || "", /Specify at least one executor/);
});

test("CLI rejects unknown commands", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--unknown-command"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr || "", /Unknown command/);
});

test("buildErrorClusters applies a strict date window cutoff", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorClusters = assertFunction(moduleNs, "buildErrorClusters");

  const clusters = buildErrorClusters(ERRORS_FIXTURE, {
    days: 2,
    top: 10,
    now: FIXED_NOW,
  });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].fingerprint, "timeout_error");
  assert.equal(clusters[0].count, 1);
});

test("buildErrorCorrelationPayload computes deterministic distributions", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorCorrelationPayload = assertFunction(
    moduleNs,
    "buildErrorCorrelationPayload",
  );

  const payload = buildErrorCorrelationPayload({
    errors: ERRORS_FIXTURE,
    metrics: METRICS_FIXTURE,
    days: 7,
    top: 3,
    now: FIXED_NOW,
  });

  assert.equal(payload.correlations.length, 3);

  const timeout = payload.correlations.find(
    (entry) => entry.fingerprint === "timeout_error",
  );
  assert.ok(timeout);
  assert.deepEqual(timeout.by_executor, [
    { label: "codex", count: 3, percent: 100 },
  ]);
  assert.equal(timeout.by_size[0].label, "m");
  assert.equal(timeout.by_size[0].percent, 66.66666666666667);
});

test("buildErrorCorrelationPayload tolerates malformed error rows", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorCorrelationPayload = assertFunction(
    moduleNs,
    "buildErrorCorrelationPayload",
  );

  const payload = buildErrorCorrelationPayload({
    errors: [
      {
        timestamp: "not-a-date",
        task_id: "",
        data: {},
      },
    ],
    metrics: [],
    days: 7,
    top: 5,
    now: FIXED_NOW,
  });

  assert.equal(payload.total_errors, 1);
  assert.equal(payload.total_fingerprints, 1);
  assert.equal(payload.correlations.length, 1);
  assert.equal(payload.correlations[0].fingerprint, "unknown");
  assert.equal(payload.correlations[0].first_seen, null);
  assert.equal(payload.correlations[0].last_seen, null);
});

test("normalizeErrorFingerprint redacts variable tokens for stable grouping", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const normalizeErrorFingerprint = assertFunction(
    moduleNs,
    "normalizeErrorFingerprint",
  );

  assert.equal(
    normalizeErrorFingerprint("Timeout waiting for step 123 at 0xABCD"),
    "timeout waiting for step # at 0x#",
  );
  assert.equal(normalizeErrorFingerprint("   "), "unknown");
});

test("filterRecordsByWindow applies cutoff and supports custom timestamp keys", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const filterRecordsByWindow = assertFunction(moduleNs, "filterRecordsByWindow");

  const filtered = filterRecordsByWindow(
    [
      { ts: "2026-02-25T09:00:00.000Z", id: "recent" },
      { ts: "2026-02-10T09:00:00.000Z", id: "stale" },
      { ts: "not-a-date", id: "invalid-kept" },
    ],
    { days: 7, now: FIXED_NOW, timestampKey: "ts" },
  );

  assert.deepEqual(
    filtered.map((row) => row.id),
    ["recent", "invalid-kept"],
  );
});

test("buildErrorCorrelationSummary applies default bounds and top limit", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorCorrelationSummary = assertFunction(
    moduleNs,
    "buildErrorCorrelationSummary",
  );

  const summary = buildErrorCorrelationSummary({
    errors: ERROR_EVENTS_FIXTURE,
    metrics: METRICS_EVENTS_FIXTURE,
    windowDays: 0,
    top: 2,
  });

  assert.equal(summary.window_days, 7);
  assert.equal(summary.total_errors, 7);
  assert.equal(summary.total_fingerprints, 4);
  assert.equal(summary.top, 2);
  assert.equal(summary.correlations.length, 2);
  assert.equal(summary.correlations[0].fingerprint, "timeout");
  assert.equal(summary.correlations[0].count, 3);
});

test("buildErrorCorrelationJsonPayload falls back to safe defaults for invalid summary", async () => {
  const moduleNs = await loadAnalyzeAgentWorkModule();
  const buildErrorCorrelationJsonPayload = assertFunction(
    moduleNs,
    "buildErrorCorrelationJsonPayload",
  );

  const payload = buildErrorCorrelationJsonPayload(null, { now: FIXED_NOW });

  assert.equal(payload.generated_at, FIXED_NOW.toISOString());
  assert.equal(payload.window_days, 7);
  assert.equal(payload.total_errors, 0);
  assert.equal(payload.total_fingerprints, 0);
  assert.equal(payload.top, 0);
  assert.deepEqual(payload.correlations, []);
});

test(
  "CLI --error-correlation --json returns deterministic seeded contract output",
  { concurrency: false },
  async (t) => {
    await seedAnalyticsLogs(t, {
      errors: ERROR_EVENTS_FIXTURE,
      metrics: METRICS_EVENTS_FIXTURE,
      stream: null,
    });

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--error-correlation",
        "--days",
        "7",
        "--top",
        "2",
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.window_days, 7);
    assert.equal(parsed.total_errors, 6);
    assert.equal(parsed.total_fingerprints, 3);
    assert.equal(parsed.top, 2);
    assert.equal(parsed.correlations.length, 2);
    assert.equal(parsed.correlations[0].fingerprint, "timeout");
    assert.equal(parsed.correlations[0].count, 3);
    assert.deepEqual(parsed.correlations[0].by_executor, [
      { label: "codex", count: 2, percent: 66.66666666666667 },
      { label: "copilot", count: 1, percent: 33.333333333333336 },
    ]);
  },
);
