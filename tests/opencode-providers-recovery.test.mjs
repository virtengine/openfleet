import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const execMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: execFileMock,
    exec: execMock,
  };
});

describe("opencode provider discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@opencode-ai/sdk");
    execFileMock.mockReset();
    execMock.mockReset();
  });

  it("falls back to basic CLI model listing after verbose 400", async () => {
    execFileMock
      .mockImplementationOnce((command, args, options, callback) => callback(new Error("Failed to list models: 400")))
      .mockImplementationOnce((command, args, options, callback) => callback(null, "openai/gpt-4.1\nanthropic/claude-3-5-sonnet\n", ""));

    execMock
      .mockImplementationOnce((command, options, callback) => callback(new Error("Failed to list models: 400")))
      .mockImplementationOnce((command, options, callback) => callback(null, "openai/gpt-4.1\nanthropic/claude-3-5-sonnet\n", ""));

    const mod = await import("../shell/opencode-providers.mjs?case=cli400");
    const snapshot = await mod.discoverProviders({ force: true });

    expect(snapshot.connectedIds).toEqual(["openai", "anthropic"]);
    expect(snapshot.allModels.map((model) => model.fullId)).toEqual([
      "openai/gpt-4.1",
      "anthropic/claude-3-5-sonnet",
    ]);
  });

  it("falls back when verbose CLI writes 400 only to stderr", async () => {
    execFileMock
      .mockImplementationOnce((command, args, options, callback) => callback(null, "", "Failed to list models: 400"))
      .mockImplementationOnce((command, args, options, callback) => callback(null, "openai/gpt-4.1\n", ""));

    execMock
      .mockImplementationOnce((command, options, callback) => callback(null, "", "Failed to list models: 400"))
      .mockImplementationOnce((command, options, callback) => callback(null, "openai/gpt-4.1\n", ""));

    const mod = await import("../shell/opencode-providers.mjs?case=stderr400");
    const snapshot = await mod.discoverProviders({ force: true });

    expect(snapshot.connectedIds).toEqual(["openai"]);
    expect(snapshot.allModels.map((model) => model.fullId)).toEqual(["openai/gpt-4.1"]);
  });

  it("treats stderr-only 400 text on thrown fallback errors as ignorable", async () => {
    execFileMock
      .mockImplementationOnce((command, args, options, callback) => callback(new Error("verbose failed")))
      .mockImplementationOnce((command, args, options, callback) => {
        const err = new Error("");
        err.stderr = "Failed to list models: 400";
        callback(err);
      });

    execMock
      .mockImplementationOnce((command, options, callback) => callback(new Error("verbose failed")))
      .mockImplementationOnce((command, options, callback) => {
        const err = new Error("");
        err.stderr = "Failed to list models: 400";
        callback(err);
      });

    const mod = await import("../shell/opencode-providers.mjs?case=stderr-thrown-400");
    const snapshot = await mod.discoverProviders({ force: true });

    expect(snapshot.connectedIds).toEqual([]);
    expect(snapshot.allModels).toEqual([]);
  });

  it("recovers provider metadata from SDK 400 payloads", async () => {
    const providerPayload = {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          models: {
            "gpt-5": {
              id: "gpt-5",
              name: "GPT-5",
              status: "active",
              reasoning: true,
              tool_call: true,
              limit: { context: 400000, output: 8000 },
              cost: { input: 1.25, output: 10 },
            },
          },
        },
      ],
      connectedIds: ["openai"],
      defaults: { openai: "gpt-5" },
    };

    const createOpencodeClient = vi.fn(() => ({
      provider: {
        list: vi.fn().mockRejectedValue(Object.assign(new Error("Failed to list models: 400"), {
          status: 400,
          response: { data: providerPayload },
        })),
        auth: vi.fn().mockResolvedValue({ data: {} }),
      },
    }));

    vi.doMock("@opencode-ai/sdk", () => ({
      default: { createOpencodeClient },
      createOpencodeClient,
    }));

    const mod = await import("../shell/opencode-providers.mjs?case=sdk400-payload");
    const snapshot = await mod.discoverProviders({ force: true });

    expect(createOpencodeClient).toHaveBeenCalled();
    expect(snapshot.connectedIds).toEqual(["openai"]);
    expect(snapshot.defaults).toEqual({ openai: "gpt-5" });
    expect(snapshot.allModels.map((model) => model.fullId)).toEqual(["openai/gpt-5"]);
    expect(snapshot.providers[0].models[0]).toMatchObject({
      fullId: "openai/gpt-5",
      reasoning: true,
      toolcall: true,
    });
  });
});
