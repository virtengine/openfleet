/**
 * heavy-runner-pool.mjs — Isolated execution leases for heavyweight validation.
 *
 * Provides a lightweight runner-pool abstraction that executes expensive build,
 * test, diff, and pre-push commands outside the main Bosun process while
 * preserving compacted output and artifact retrieval.
 */

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const DEFAULT_RUNTIME = String(process.env.BOSUN_HEAVY_RUNNER_RUNTIME || "local-process").trim() || "local-process";
const DEFAULT_RETRIES = Math.max(0, Number(process.env.BOSUN_HEAVY_RUNNER_RETRIES || 0) || 0);
const DEFAULT_ARTIFACT_DIR = ".bosun/artifacts/heavy-runners";
const SUPPORTED_RUNTIMES = new Set(["local-process", "local-container", "remote-sandbox"]);

class RunnerLeaseError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = "RunnerLeaseError";
    this.retryable = retryable !== false;
  }
}

function normalizeRuntime(rawRuntime) {
  const runtime = String(rawRuntime || DEFAULT_RUNTIME).trim().toLowerCase();
  return SUPPORTED_RUNTIMES.has(runtime) ? runtime : DEFAULT_RUNTIME;
}

function normalizeRunnerConfig(runner = null) {
  if (runner === false) {
    return {
      enabled: false,
      runtime: DEFAULT_RUNTIME,
      retries: DEFAULT_RETRIES,
      artifactDir: DEFAULT_ARTIFACT_DIR,
      commandPrefix: [],
    };
  }
  const source = runner && typeof runner === "object" ? runner : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : null,
    runtime: normalizeRuntime(source.runtime),
    retries: Math.max(0, Number(source.retries ?? DEFAULT_RETRIES) || 0),
    artifactDir: String(source.artifactDir || DEFAULT_ARTIFACT_DIR),
    commandPrefix: Array.isArray(source.commandPrefix)
      ? source.commandPrefix.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
  };
}

export function detectHeavyRunnerIntent(command = "", nodeType = "") {
  const lowerCommand = String(command || "").trim().toLowerCase();
  const normalizedNodeType = String(nodeType || "").trim().toLowerCase();
  if (normalizedNodeType === "validation.tests") return "test";
  if (normalizedNodeType === "validation.build") return "build";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test|run\s+ci)\b/.test(lowerCommand)) return "test";
  if (/\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/.test(lowerCommand)) return "test";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(lowerCommand)) return "build";
  if (/\b(?:tsc|cargo\s+build|dotnet\s+build|mvn\s+(?:package|verify)|gradle\s+build)\b/.test(lowerCommand)) return "build";
  if (/\bgit\s+diff\b/.test(lowerCommand)) return "diff";
  if (/\.githooks[\\/]+pre-push\b/.test(lowerCommand) || /\bpre-push\b/.test(lowerCommand)) return "pre-push";
  return "generic";
}

export function resolveHeavyRunnerPolicy({
  nodeType = "",
  command = "",
  timeoutMs = 0,
  runner = null,
} = {}) {
  const runnerConfig = normalizeRunnerConfig(runner);
  const intent = detectHeavyRunnerIntent(command, nodeType);
  const timeout = Math.max(0, Number(timeoutMs) || 0);

  if (runnerConfig.enabled === false) {
    return {
      lane: "main",
      reason: "Runner pool disabled for this node.",
      intent,
      runtime: runnerConfig.runtime,
      retries: runnerConfig.retries,
      artifactDir: runnerConfig.artifactDir,
      commandPrefix: runnerConfig.commandPrefix,
    };
  }

  if (runnerConfig.enabled === true) {
    return {
      lane: "runner-pool",
      reason: "Runner pool explicitly enabled for this node.",
      intent,
      runtime: runnerConfig.runtime,
      retries: runnerConfig.retries,
      artifactDir: runnerConfig.artifactDir,
      commandPrefix: runnerConfig.commandPrefix,
    };
  }

  if (nodeType === "validation.tests" || nodeType === "validation.build") {
    return {
      lane: "runner-pool",
      reason: "Heavy validation defaults to isolated runner execution.",
      intent,
      runtime: runnerConfig.runtime,
      retries: runnerConfig.retries,
      artifactDir: runnerConfig.artifactDir,
      commandPrefix: runnerConfig.commandPrefix,
    };
  }

  if ((intent === "diff" || intent === "pre-push") && timeout >= 30000) {
    return {
      lane: "runner-pool",
      reason: "Heavy git validation is isolated from the main executor.",
      intent,
      runtime: runnerConfig.runtime,
      retries: runnerConfig.retries,
      artifactDir: runnerConfig.artifactDir,
      commandPrefix: runnerConfig.commandPrefix,
    };
  }

  return {
    lane: "main",
    reason: "Lightweight work stays on the main executor.",
    intent,
    runtime: runnerConfig.runtime,
    retries: runnerConfig.retries,
    artifactDir: runnerConfig.artifactDir,
    commandPrefix: runnerConfig.commandPrefix,
  };
}

function ensureLeaseDir(artifactRoot, leaseId) {
  const rootDir = resolve(String(artifactRoot || DEFAULT_ARTIFACT_DIR));
  mkdirSync(rootDir, { recursive: true });
  const leaseDir = resolve(rootDir, leaseId);
  mkdirSync(leaseDir, { recursive: true });
  return leaseDir;
}

function writeLeaseMetadata(metadataPath, metadata) {
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
}

function buildArtifactPointers(stdoutPath, stderrPath, metadataPath) {
  return [
    { kind: "stdout", path: stdoutPath },
    { kind: "stderr", path: stderrPath },
    { kind: "metadata", path: metadataPath },
  ];
}

function buildBlockedResult(policy, attemptCount, message, artifactRoot) {
  const leaseId = randomUUID();
  const leaseDir = ensureLeaseDir(artifactRoot || policy.artifactDir, leaseId);
  const metadataPath = resolve(leaseDir, "lease.json");
  const lease = {
    leaseId,
    status: "blocked",
    lane: "runner-pool",
    runtime: policy.runtime,
    intent: policy.intent,
    isolated: true,
    attempts: attemptCount,
  };
  const blockedEvidence = {
    summary: `Failed to acquire ${policy.runtime} runner lease after ${attemptCount} attempt(s): ${message}`,
  };
  writeLeaseMetadata(metadataPath, {
    ...lease,
    blockedEvidence,
    reason: message,
  });
  return {
    ok: false,
    blocked: true,
    failureKind: "runner_lease_failed",
    attempts: attemptCount,
    exitCode: 1,
    stdout: "",
    stderr: blockedEvidence.summary,
    durationMs: 0,
    lease: {
      ...lease,
      metadataPath,
    },
    artifactPointers: [{ kind: "metadata", path: metadataPath }],
    blockedEvidence,
  };
}

async function runLeaseAttempt({
  command,
  cwd,
  env,
  timeoutMs,
  runtime,
  artifactRoot,
  commandPrefix,
  intent,
  attempt,
}) {
  const leaseId = randomUUID();
  const leaseDir = ensureLeaseDir(artifactRoot, leaseId);
  const stdoutPath = resolve(leaseDir, "stdout.log");
  const stderrPath = resolve(leaseDir, "stderr.log");
  const metadataPath = resolve(leaseDir, "lease.json");
  const startedAt = Date.now();
  const lease = {
    leaseId,
    status: "running",
    lane: "runner-pool",
    runtime,
    intent,
    isolated: true,
    attempt,
    startedAt: new Date(startedAt).toISOString(),
  };
  writeLeaseMetadata(metadataPath, lease);

  let launchCommand = command;
  let launchArgs = [];
  let useShell = true;

  if (runtime !== "local-process") {
    if (!Array.isArray(commandPrefix) || commandPrefix.length === 0) {
      throw new RunnerLeaseError(`No commandPrefix configured for ${runtime} runner leases.`, { retryable: attempt <= 1 });
    }
    launchCommand = commandPrefix[0];
    launchArgs = [...commandPrefix.slice(1), command];
    useShell = false;
  }

  return await new Promise((resolveRun, rejectRun) => {
    const stdoutStream = createWriteStream(stdoutPath, { encoding: "utf8" });
    const stderrStream = createWriteStream(stderrPath, { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(launchCommand, launchArgs, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      shell: useShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timer = null;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutStream.end();
      stderrStream.end();
      rejectRun(error);
    };

    const finishResolve = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutStream.end();
      stderrStream.end();
      resolveRun(result);
    };

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutStream.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrStream.write(text);
    });

    child.on("error", (error) => {
      finishReject(new RunnerLeaseError(`Runner process spawn failed: ${error.message}`, { retryable: true }));
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // best effort
      }
    }, Math.max(1, Number(timeoutMs) || 1));

    child.on("close", (code, signal) => {
      const endedAt = Date.now();
      const exitCode = Number.isInteger(code) ? code : (timedOut ? 124 : 1);
      const status = timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed";
      const metadata = {
        ...lease,
        status,
        exitCode,
        signal: signal || null,
        timedOut,
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      };
      writeLeaseMetadata(metadataPath, metadata);
      finishResolve({
        ok: exitCode === 0 && !timedOut,
        blocked: false,
        attempts: attempt,
        exitCode,
        stdout,
        stderr,
        durationMs: endedAt - startedAt,
        lease: {
          ...metadata,
          metadataPath,
        },
        artifactPointers: buildArtifactPointers(stdoutPath, stderrPath, metadataPath),
      });
    });
  });
}

export async function runCommandInHeavyRunnerLease({
  command = "",
  cwd = process.cwd(),
  env = {},
  timeoutMs = 600000,
  runtime = undefined,
  intent = undefined,
  artifactRoot = undefined,
  retries = undefined,
  commandPrefix = undefined,
  runner = null,
  nodeType = "",
} = {}) {
  const policy = resolveHeavyRunnerPolicy({
    nodeType,
    command,
    timeoutMs,
    runner: runner || {
      enabled: true,
      runtime,
      retries,
      artifactDir: artifactRoot,
      commandPrefix,
    },
  });

  const totalAttempts = Math.max(1, Number(policy.retries) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await runLeaseAttempt({
        command,
        cwd,
        env,
        timeoutMs,
        runtime: policy.runtime,
        artifactRoot: artifactRoot || policy.artifactDir,
        commandPrefix: Array.isArray(commandPrefix) && commandPrefix.length ? commandPrefix : policy.commandPrefix,
        intent: intent || policy.intent,
        attempt,
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof RunnerLeaseError) || error.retryable !== true || attempt >= totalAttempts) {
        break;
      }
    }
  }

  return buildBlockedResult(
    { ...policy, intent: intent || policy.intent },
    totalAttempts,
    String(lastError?.message || lastError || "runner lease failed"),
    artifactRoot || policy.artifactDir,
  );
}
