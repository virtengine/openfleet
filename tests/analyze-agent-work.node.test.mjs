import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/analyze-agent-work");
const METRICS_FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "metrics.json"), "utf8"),
);
const ERRORS_FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "errors.json"), "utf8"),
);
const FIXED_NOW = new Date("2026-02-26T12:00:00.000Z");

function assertFunction(moduleNs, name) {
  assert.equal(
    typeof moduleNs[name],
    "function",
    `expected ${name} to be exported as a function`,
  );
  return moduleNs[name];
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
    moduleUrl.searchParams.set(
      "node_test",
      `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    );
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
  assertFunction(moduleNs, "buildErrorClusters");
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
  const scriptPath = resolve(process.cwd(), "analyze-agent-work.mjs");
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
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
