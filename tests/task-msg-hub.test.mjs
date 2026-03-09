import { describe, expect, it, vi } from "vitest";

import { MsgHub } from "../task/msg-hub.mjs";

describe("MsgHub", () => {
  it("broadcasts sanitized references to every other participant", async () => {
    const hub = await MsgHub.create(["agent-a", "agent-b", "agent-c"]);
    const handler = vi.fn();
    hub.subscribe("agent-b", handler);

    const deliveries = hub.publish("agent-a", {
      taskId: "task-1",
      summary: "updated branch and tests",
      paths: ["task/pipeline.mjs"],
      transcript: "should-not-leak",
    });

    expect(deliveries).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].message).toEqual({
      taskId: "task-1",
      summary: "updated branch and tests",
      paths: ["task/pipeline.mjs"],
    });
    expect(hub.drain("agent-c")).toHaveLength(1);
    hub.close();
  });

  it("supports dynamic membership", async () => {
    const hub = await MsgHub.create(["agent-a"]);
    hub.add({ id: "agent-b", name: "Agent B" });
    expect(hub.has("agent-b")).toBe(true);
    expect(hub.remove("agent-b")).toBe(true);
    expect(hub.has("agent-b")).toBe(false);
    hub.close();
  });
});
