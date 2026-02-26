import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

function asDataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const CODEX_STUB_URL = asDataUrl(`
function getState() {
  if (!globalThis.__agentPoolTestState) {
    globalThis.__agentPoolTestState = {
      codexBehaviors: [],
      codexStartCalls: 0,
      codexResumeCalls: 0,
    };
  }
  return globalThis.__agentPoolTestState;
}

function nextBehavior() {
  const state = getState();
  if (!Array.isArray(state.codexBehaviors) || state.codexBehaviors.length === 0) {
    return { type: "success", text: "codex ok" };
  }
  return state.codexBehaviors.shift();
}

export class Codex {
  constructor() {}

  startThread() {
    const state = getState();
    state.codexStartCalls = (state.codexStartCalls || 0) + 1;

    const behavior = nextBehavior();
    if (behavior.type === "null") return null;
    const threadId = behavior.threadId || "codex-thread";
    return {
      id: threadId,
      async runStreamed() {
        if (behavior.type === "error") {
          throw new Error(behavior.error || "codex error");
        }
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              if (behavior.noOutput) return;
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: behavior.text || "codex ok" },
              };
            },
          },
        };
      },
    };
  }

  resumeThread(threadId) {
    const state = getState();
    state.codexResumeCalls = (state.codexResumeCalls || 0) + 1;
    return {
      id: threadId || "codex-thread",
      async runStreamed() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "codex resumed" },
              };
            },
          },
        };
      },
    };
  }
}
`);

const COPILOT_STUB_URL = asDataUrl(`
export class CopilotClient {
  async start() {}
  async stop() {}
  async createSession() {
    return {
      sessionId: "copilot-session",
      async sendAndWait() {},
      on(cb) {
        cb({ type: "assistant.message", data: { content: "copilot output" } });
        return () => {};
      },
    };
  }
}
`);

const CLAUDE_STUB_URL = asDataUrl(`
export function query() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "assistant",
        session_id: "claude-session",
        message: { content: [{ type: "text", text: "claude output" }] },
      };
      yield { type: "result", session_id: "claude-session" };
    },
  };
}
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openai/codex-sdk") {
      return { shortCircuit: true, url: CODEX_STUB_URL };
    }
    if (specifier === "@github/copilot-sdk") {
      return { shortCircuit: true, url: COPILOT_STUB_URL };
    }
    if (specifier === "@anthropic-ai/claude-agent-sdk") {
      return { shortCircuit: true, url: CLAUDE_STUB_URL };
    }
    return nextResolve(specifier, context);
  },
});

const ENV_KEYS = [
  "AGENT_POOL_SDK",
  "AGENT_POOL_SDK_FAILURE_COOLDOWN_MS",
  "__MOCK_CODEX_AVAILABLE",
  "CODEX_SDK_DISABLED",
  "COPILOT_SDK_DISABLED",
  "CLAUDE_SDK_DISABLED",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
];

let envSnapshot = {};
let importCounter = 0;

function saveEnv() {
  envSnapshot = {};
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
}

function setBaseEnv() {
  process.env.AGENT_POOL_SDK = "codex";
  process.env.__MOCK_CODEX_AVAILABLE = "1";
  process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS = "120000";
  process.env.COPILOT_SDK_DISABLED = "1";
  process.env.CLAUDE_SDK_DISABLED = "1";
}

function resetTestState() {
  globalThis.__agentPoolTestState = {
    codexBehaviors: [],
    codexStartCalls: 0,
    codexResumeCalls: 0,
  };
}

async function importAgentPoolFresh() {
  importCounter += 1;
  const url = new URL("../agent-pool.mjs", import.meta.url);
  url.searchParams.set("node_test", String(importCounter));
  const mod = await import(url.href);
  await mod.ensureThreadRegistryLoaded();
  mod.clearThreadRegistry();
  return mod;
}

beforeEach(() => {
  saveEnv();
  setBaseEnv();
  resetTestState();
});

afterEach(() => {
  restoreEnv();
  delete globalThis.__agentPoolTestState;
});

describe("monitor-monitor cooldown bypass", () => {
  it("keeps non-monitor tasks blocked while codex is in cooldown", async () => {
    const mod = await importAgentPoolFresh();
    const state = globalThis.__agentPoolTestState;
    state.codexBehaviors.push({ type: "error", error: "timeout during codex call" });

    const first = await mod.launchOrResumeThread("prime cooldown", process.cwd(), 250, {
      taskKey: "task-a",
      sdk: "codex",
    });
    assert.equal(first.success, false);
    assert.match(String(first.error || ""), /timeout/i);
    assert.equal(state.codexStartCalls, 1);

    const second = await mod.launchOrResumeThread("normal task while cooling", process.cwd(), 250, {
      taskKey: "task-b",
      sdk: "codex",
    });
    assert.equal(second.success, false);
    assert.match(String(second.error || ""), /Cooling down: codex/i);
    assert.equal(state.codexStartCalls, 1);
  });

  it("auto-bypasses cooldown for monitor-monitor when ignoreSdkCooldown is not provided", async () => {
    const mod = await importAgentPoolFresh();
    const state = globalThis.__agentPoolTestState;
    state.codexBehaviors.push({ type: "error", error: "timeout priming cooldown" });
    state.codexBehaviors.push({ type: "success", text: "monitor recovered" });

    await mod.launchOrResumeThread("prime cooldown", process.cwd(), 250, {
      taskKey: "task-a",
      sdk: "codex",
    });
    assert.equal(state.codexStartCalls, 1);

    const monitorResult = await mod.launchOrResumeThread("health check", process.cwd(), 250, {
      taskKey: "monitor-monitor",
      sdk: "codex",
    });
    assert.equal(monitorResult.success, true);
    assert.equal(state.codexStartCalls, 2);
    assert.match(String(monitorResult.output || ""), /monitor recovered/i);
  });

  it("respects explicit ignoreSdkCooldown=false for monitor-monitor", async () => {
    const mod = await importAgentPoolFresh();
    const state = globalThis.__agentPoolTestState;
    state.codexBehaviors.push({ type: "error", error: "timeout priming cooldown" });

    await mod.launchOrResumeThread("prime cooldown", process.cwd(), 250, {
      taskKey: "task-a",
      sdk: "codex",
    });
    assert.equal(state.codexStartCalls, 1);

    const monitorResult = await mod.launchOrResumeThread("health check", process.cwd(), 250, {
      taskKey: "monitor-monitor",
      sdk: "codex",
      ignoreSdkCooldown: false,
    });
    assert.equal(monitorResult.success, false);
    assert.match(String(monitorResult.error || ""), /Cooling down: codex/i);
    assert.equal(state.codexStartCalls, 1);
  });

  it("treats whitespace-padded monitor task keys as monitor-monitor", async () => {
    const mod = await importAgentPoolFresh();
    const state = globalThis.__agentPoolTestState;
    state.codexBehaviors.push({ type: "error", error: "timeout priming cooldown" });
    state.codexBehaviors.push({ type: "success", text: "trimmed monitor key worked" });

    await mod.launchOrResumeThread("prime cooldown", process.cwd(), 250, {
      taskKey: "task-a",
      sdk: "codex",
    });
    assert.equal(state.codexStartCalls, 1);

    const monitorResult = await mod.launchOrResumeThread("health check", process.cwd(), 250, {
      taskKey: "  monitor-monitor  ",
      sdk: "codex",
    });
    assert.equal(monitorResult.success, true);
    assert.match(String(monitorResult.output || ""), /trimmed monitor key worked/i);
    assert.equal(state.codexStartCalls, 2);
  });
});
