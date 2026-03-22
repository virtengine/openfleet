import { beforeEach, describe, expect, it, vi } from "vitest";

describe("context envelope builder", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("builds a shared envelope from compacted command payloads", async () => {
    const { buildContextEnvelope } = await import("../workspace/context-envelope.mjs");

    const envelope = await buildContextEnvelope({
      commandPayload: {
        command: "git",
        args: ["diff", "--stat"],
        output: Array.from({ length: 80 }, (_, i) => ` file${i}.mjs | ${i + 1} +`).join("\n"),
      },
      continuation: { workflowId: "wf-123" },
    });

    expect(envelope.command).toBeDefined();
    expect(envelope.command.family).toBe("git");
    expect(envelope.command.budget).toBeDefined();
    expect(envelope.continuation.workflowId).toBe("wf-123");
  });
});
