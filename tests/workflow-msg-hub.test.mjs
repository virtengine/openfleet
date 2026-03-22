import { describe, it, expect } from "vitest";
import { MsgHub } from "../workflow/msg-hub.mjs";

describe("MsgHub", () => {
  it("broadcasts lightweight references and supports dynamic membership", async () => {
    const received = [];
    const hub = await MsgHub.create([
      { id: "agent-a" },
      { id: "agent-b", onMessage: (message) => received.push(message) },
    ]);

    hub.add({ id: "agent-c" });
    expect(hub.listParticipants().map((entry) => entry.id)).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
    ]);

    await hub.publish("agent-a", {
      kind: "agent-output",
      taskId: "task-42",
      summary: "done",
      messages: ["too heavy"],
      extra: "kept-as-metadata",
      filePaths: ["src/a.mjs"],
    });

    expect(received).toHaveLength(1);
    expect(received[0].message).toEqual(expect.objectContaining({
      taskId: "task-42",
      summary: "done",
      filePaths: ["src/a.mjs"],
      metadata: expect.objectContaining({ extra: "kept-as-metadata" }),
    }));
    expect(received[0].message.messages).toBeUndefined();

    expect(hub.remove("agent-c")).toBe(true);
    expect(hub.listParticipants().map((entry) => entry.id)).toEqual([
      "agent-a",
      "agent-b",
    ]);

    await hub.close();
  });
});
