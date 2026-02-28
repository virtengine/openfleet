import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStartThread = vi.fn();

vi.mock("@openai/codex-sdk", () => ({
  Codex: class MockCodex {
    startThread(...args) {
      return mockStartThread(...args);
    }
  },
}));

vi.mock("../agent-sdk.mjs", () => ({
  resolveAgentSdkConfig: vi.fn(() => ({
    primary: "codex",
    capabilities: { steering: true },
  })),
}));

vi.mock("../repo-root.mjs", () => ({
  resolveRepoRoot: vi.fn(() => process.cwd()),
}));

vi.mock("../codex-model-profiles.mjs", () => ({
  resolveCodexProfileRuntime: vi.fn(() => ({ env: {} })),
}));

vi.mock("../config.mjs", () => ({
  loadConfig: vi.fn(() => ({
    internalExecutor: {
      stream: {
        firstEventTimeoutMs: Number(
          process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS || 120000,
        ),
        maxItemsPerTurn: Number(
          process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN || 600,
        ),
        maxItemChars: Number(
          process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS || 12000,
        ),
      },
    },
  })),
}));

vi.mock("../stream-resilience.mjs", () => ({
  MAX_STREAM_RETRIES: 2,
  streamRetryDelay: () => 0,
  isTransientStreamError: (err) =>
    String(err?.message || "").toLowerCase().includes("stream disconnected"),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const {
  execCodexPrompt,
  resetThread,
} = await import("../codex-shell.mjs");

const ENV_KEYS = [
  "INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS",
];

let savedEnv = {};

function saveEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

describe("codex-shell stream safeguards", () => {
  beforeEach(async () => {
    saveEnv();
    mockStartThread.mockReset();
    await resetThread();
  });

  afterEach(async () => {
    restoreEnv();
    await resetThread();
  });

  it("retries when first stream event never arrives", async () => {
    process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS = "1000";

    let runAttempt = 0;
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-timeout",
      runStreamed: async (_prompt, { signal } = {}) => {
        runAttempt += 1;
        if (runAttempt === 1) {
          return {
            events: {
              async *[Symbol.asyncIterator]() {
                await new Promise((_, reject) => {
                  const abortNow = () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                  };
                  if (signal?.aborted) {
                    abortNow();
                    return;
                  }
                  signal?.addEventListener("abort", abortNow, { once: true });
                });
              },
            },
          };
        }

        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "recovered output" },
              };
              yield { type: "turn.completed" };
            },
          },
        };
      },
    }));

    const result = await execCodexPrompt("recover from stalled stream", {
      timeoutMs: 2500,
    });

    expect(result.finalResponse).toContain("recovered output");
    expect(runAttempt).toBe(2);
  });

  it("caps retained items and truncates oversized item payloads", async () => {
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN = "1";
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS = "12";

    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-caps",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: {
                type: "command_execution",
                aggregated_output: "abcdefghijklmnopqrstuvwxyz",
              },
            };
            yield {
              type: "item.completed",
              item: {
                type: "command_execution",
                aggregated_output: "this item should be dropped",
              },
            };
            yield {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "final answer",
              },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await execCodexPrompt("test item cap", {
      timeoutMs: 5000,
    });

    expect(result.finalResponse).toContain("final answer");
    expect(result.items.length).toBe(2);
    expect(result.items[0].aggregated_output).toContain("…truncated");
    expect(result.items[1]).toMatchObject({ type: "stream_notice" });
  });
});
