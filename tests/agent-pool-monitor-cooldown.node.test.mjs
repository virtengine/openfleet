import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(resolve(process.cwd(), "agent-pool.mjs"), "utf8");
const START_MARKER = "export async function launchOrResumeThread(";
const END_MARKER = "\nexport async function execWithRetry(";

function extractLaunchOrResumeThread() {
  const start = source.indexOf(START_MARKER);
  assert.notEqual(start, -1, "launchOrResumeThread export not found");

  const end = source.indexOf(END_MARKER, start);
  assert.notEqual(end, -1, "launchOrResumeThread end marker not found");

  return source
    .slice(start, end)
    .replace("export async function launchOrResumeThread(", "async function launchOrResumeThread(");
}

function createHarness({ taskRecord = null } = {}) {
  const launchCalls = [];
  const resumeCodexCalls = [];
  const threadRegistry = new Map();
  if (taskRecord?.taskKey) {
    threadRegistry.set(taskRecord.taskKey, { ...taskRecord });
  }

  const context = {
    DEFAULT_TIMEOUT_MS: 5000,
    REPO_ROOT: "/repo",
    TAG: "[test]",
    MONITOR_MONITOR_TASK_KEY: "monitor-monitor",
    THREAD_EXHAUSTION_WARNING_THRESHOLD: 20,
    MAX_THREAD_TURNS: 40,
    THREAD_MAX_ABSOLUTE_AGE_MS: 1_000_000_000,
    threadRegistry,
    ensureThreadRegistryLoaded: async () => {},
    clampMonitorMonitorTimeout: (timeoutMs) => timeoutMs,
    launchEphemeralThread: async (prompt, cwd, timeoutMs, extra = {}) => {
      launchCalls.push({ prompt, cwd, timeoutMs, extra });
      if (typeof extra.onThreadReady === "function") {
        extra.onThreadReady("fresh-thread-id", extra.sdk || "codex");
      }
      return {
        success: true,
        output: "ok",
        items: [],
        error: null,
        sdk: extra.sdk || "codex",
        threadId: "fresh-thread-id",
      };
    },
    resumeCodexThread: async (threadId, prompt, cwd, timeoutMs, extra = {}) => {
      resumeCodexCalls.push({ threadId, prompt, cwd, timeoutMs, extra });
      return {
        success: true,
        output: "resumed",
        items: [],
        error: null,
        sdk: "codex",
        threadId,
      };
    },
    resumeCopilotThread: async () => ({
      success: false,
      output: "",
      items: [],
      error: "not used",
      sdk: "copilot",
      threadId: null,
    }),
    resumeClaudeThread: async () => ({
      success: false,
      output: "",
      items: [],
      error: "not used",
      sdk: "claude",
      threadId: null,
    }),
    resumeGenericThread: async () => ({
      success: false,
      output: "",
      items: [],
      error: "not used",
      sdk: "codex",
      threadId: null,
    }),
    saveThreadRegistry: () => Promise.resolve(),
    resolvePoolSdkName: () => "codex",
    sdkSupportsPersistentThreads: () => true,
    isPoisonedCodexResumeError: () => false,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    Date,
    result: null,
  };

  const script = `${extractLaunchOrResumeThread()}\nresult = { launchOrResumeThread };`;
  vm.createContext(context);
  new vm.Script(script).runInContext(context);

  return {
    launchOrResumeThread: context.result.launchOrResumeThread,
    launchCalls,
    resumeCodexCalls,
    threadRegistry,
  };
}

test("defaults ignoreSdkCooldown=true for monitor-monitor fresh launches", async () => {
  const harness = createHarness();
  const result = await harness.launchOrResumeThread("prompt", "/cwd", 1000, {
    taskKey: "monitor-monitor",
    sdk: "codex",
  });

  assert.equal(result.success, true);
  assert.equal(harness.launchCalls.length, 1);
  assert.equal(harness.launchCalls[0].extra.ignoreSdkCooldown, true);
});

test("preserves explicit ignoreSdkCooldown=false for monitor-monitor fresh launches", async () => {
  const harness = createHarness();
  await harness.launchOrResumeThread("prompt", "/cwd", 1000, {
    taskKey: "monitor-monitor",
    sdk: "codex",
    ignoreSdkCooldown: false,
  });

  assert.equal(harness.launchCalls.length, 1);
  assert.equal(harness.launchCalls[0].extra.ignoreSdkCooldown, false);
});

test("does not inject ignoreSdkCooldown for non-monitor tasks", async () => {
  const harness = createHarness();
  await harness.launchOrResumeThread("prompt", "/cwd", 1000, {
    taskKey: "task-123",
    sdk: "codex",
  });

  assert.equal(harness.launchCalls.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.launchCalls[0].extra,
      "ignoreSdkCooldown",
    ),
    false,
  );
});

test("does not inject ignoreSdkCooldown when taskKey is missing", async () => {
  const harness = createHarness();
  await harness.launchOrResumeThread("prompt", "/cwd", 1000, {
    sdk: "codex",
  });

  assert.equal(harness.launchCalls.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.launchCalls[0].extra,
      "ignoreSdkCooldown",
    ),
    false,
  );
});

test("propagates injected ignoreSdkCooldown=true into codex resume path", async () => {
  const harness = createHarness({
    taskRecord: {
      taskKey: "monitor-monitor",
      threadId: "existing-thread-id",
      sdk: "codex",
      alive: true,
      turnCount: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      lastError: null,
      cwd: "/cwd",
    },
  });

  const result = await harness.launchOrResumeThread("prompt", "/cwd", 1000, {
    taskKey: "monitor-monitor",
    sdk: "codex",
  });

  assert.equal(result.success, true);
  assert.equal(result.resumed, true);
  assert.equal(harness.resumeCodexCalls.length, 1);
  assert.equal(harness.resumeCodexCalls[0].extra.ignoreSdkCooldown, true);
});
