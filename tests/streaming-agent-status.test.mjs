import { beforeEach, describe, expect, it, vi } from "vitest";

let wsHandler = null;

vi.mock("../ui/modules/api.js", () => ({
  wsConnected: { value: true, subscribe: () => () => {} },
  onWsMessage: (handler) => {
    wsHandler = handler;
    return () => {};
  },
  wsSend: vi.fn(),
  apiFetch: vi.fn(),
}));

describe("streaming agent status session identity", () => {
  beforeEach(() => {
    wsHandler = null;
    vi.resetModules();
  });

  it("prefers payload.session.id over payload.taskId for state matching", async () => {
    const { startAgentStatusTracking, agentStatus } = await import("../ui/modules/streaming.js");

    startAgentStatusTracking();
    expect(typeof wsHandler).toBe("function");

    wsHandler({
      type: "session-message",
      payload: {
        taskId: "task-123",
        session: { id: "session-abc", type: "primary", status: "active" },
        message: { role: "assistant", type: "agent_message", content: "hello" },
      },
    });

    expect(agentStatus.value.state).toBe("streaming");
    expect(agentStatus.value.sessionId).toBe("session-abc");

    wsHandler({
      type: "invalidate",
      payload: { reason: "agent-response", sessionId: "session-abc" },
    });

    expect(agentStatus.value.state).toBe("idle");
    expect(agentStatus.value.sessionId).toBe("");
  });
});
