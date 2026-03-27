import { describe, expect, it, vi, beforeEach } from "vitest";

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
    execFileMock.mockReset();
    execMock.mockReset();
  });

  it("falls back to basic CLI model listing after verbose 400", async () => {
    execFileMock
      .mockImplementationOnce((command, args, options, callback) => {
        callback(new Error("Failed to list models: 400"));
      })
      .mockImplementationOnce((command, args, options, callback) => {
        callback(null, "openai/gpt-4.1\nanthropic/claude-3-5-sonnet\n", "");
      });

    execMock
      .mockImplementationOnce((command, options, callback) => {
        callback(new Error("Failed to list models: 400"));
      })
      .mockImplementationOnce((command, options, callback) => {
        callback(null, "openai/gpt-4.1\nanthropic/claude-3-5-sonnet\n", "");
      });

    const mod = await import("../shell/opencode-providers.mjs");
    const snapshot = await mod.discoverProviders({ force: true });

    expect(snapshot.connectedIds).toEqual(["openai", "anthropic"]);
    expect(snapshot.allModels.map((model) => model.fullId)).toEqual([
      "openai/gpt-4.1",
      "anthropic/claude-3-5-sonnet",
    ]);
    const totalCalls = execFileMock.mock.calls.length + execMock.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(2);
    expect(totalCalls).toBeLessThanOrEqual(3);
  });
  it("falls back when verbose CLI writes 400 only to stderr", async () => {
    execFileMock
      .mockImplementationOnce((command, args, options, callback) => {
        callback(null, "", "Failed to list models: 400");
      })
      .mockImplementationOnce((command, args, options, callback) => {
        callback(null, "openai/gpt-4.1\n", "");
      });

    execMock
      .mockImplementationOnce((command, options, callback) => {
        callback(null, "", "Failed to list models: 400");
      })
      .mockImplementationOnce((command, options, callback) => {
        callback(null, "openai/gpt-4.1\n", "");
      });

    const mod = await import("../shell/opencode-providers.mjs");
    const snapshot = await mod.discoverProviders({ force: true });

    expect(snapshot.connectedIds).toEqual(["openai"]);
    expect(snapshot.allModels.map((model) => model.fullId)).toEqual([
      "openai/gpt-4.1",
    ]);
  });
});




