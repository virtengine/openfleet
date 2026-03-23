import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agent-event-bus tracing integration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records agent errors as tracing metrics", async () => {
    const tracing = await import("../infra/tracing.mjs");
    const { createAgentEventBus, AGENT_EVENT } = await import("../agent/agent-event-bus.mjs");

    await tracing.setupTracing("http://collector.example/v1/traces");
    const bus = createAgentEventBus();
    bus.emit(AGENT_EVENT.AGENT_ERROR, "task-1", {
      errorType: "rate_limited",
      executor: "codex",
      sdk: "openai",
    });

    const metrics = tracing.getMetricSnapshot();
    expect(metrics.counters.get("bosun.agent.errors")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 1,
          attributes: expect.objectContaining({
            "bosun.error.type": "rate_limited",
            "bosun.task.id": "task-1",
          }),
        }),
      ]),
    );
  });
});
