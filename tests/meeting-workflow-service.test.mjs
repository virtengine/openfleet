import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTracker } from "../session-tracker.mjs";
import { createMeetingWorkflowService } from "../meeting-workflow-service.mjs";

function createHarness(overrides = {}) {
  let nowMs = 1_700_000_000_000;
  let messageCounter = 0;

  const tracker = createSessionTracker({
    maxMessages: 200,
    persistDir: null,
  });

  const execPrimaryPrompt =
    overrides.execPrimaryPrompt
    || vi.fn(async (message, opts) => ({
      finalResponse: `ACK:${message}`,
      threadId: opts.sessionId,
      adapter: "mock-agent",
      usage: { tokens: 5 },
    }));

  const analyzeVisionFrame =
    overrides.analyzeVisionFrame
    || vi.fn(async () => ({
      summary: "Editor and terminal are visible with one failing test.",
      provider: "mock-vision-provider",
      model: "mock-vision-model",
    }));

  const service = createMeetingWorkflowService({
    sessionTracker: tracker,
    execPrimaryPrompt,
    analyzeVisionFrame,
    isVoiceAvailable: () => ({ available: true, tier: 1, provider: "openai" }),
    getVoiceConfig: () => ({
      provider: "openai",
      model: "gpt-4o-realtime-preview",
      visionModel: "gpt-4o-mini",
      voiceId: "alloy",
      turnDetection: "semantic_vad",
      fallbackMode: "browser",
      delegateExecutor: "codex-sdk",
      enabled: true,
    }),
    getRealtimeConnectionInfo: () => ({
      provider: "openai",
      url: "wss://example.test/realtime",
      model: "gpt-4o-realtime-preview",
    }),
    now: () => nowMs,
    createMessageId: () => `msg-${++messageCounter}`,
    getPrimaryAgentName: () => "codex-sdk",
    getAgentMode: () => "agent",
  });

  return {
    tracker,
    service,
    execPrimaryPrompt,
    analyzeVisionFrame,
    advanceClock(ms) {
      nowMs += ms;
    },
  };
}

describe("meeting-workflow-service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("startMeeting creates or reuses a session and returns voice summary", async () => {
    const { service, tracker } = createHarness();

    const created = await service.startMeeting({
      sessionId: "meeting-1",
      metadata: { workflowId: "wf-123" },
    });
    expect(created.created).toBe(true);
    expect(created.sessionId).toBe("meeting-1");
    expect(created.session.status).toBe("active");
    expect(created.session.metadata.workflowId).toBe("wf-123");
    expect(created.voice.available).toBe(true);
    expect(created.voice.provider).toBe("openai");

    const reused = await service.startMeeting({ sessionId: "meeting-1" });
    expect(reused.created).toBe(false);
    expect(tracker.getSessionById("meeting-1")).toBeTruthy();
  });

  it("sendMeetingMessage dispatches through primary agent and records streamed events", async () => {
    const execPrimaryPrompt = vi.fn(async (_message, opts) => {
      opts.onEvent?.(null, {
        type: "assistant.message",
        data: { content: "intermediate planning output" },
      });
      opts.onEvent?.(":memo: tool call finished");
      return {
        finalResponse: "Meeting follow-up sent.",
        threadId: opts.sessionId,
        adapter: "mock-agent",
      };
    });
    const { service, tracker } = createHarness({ execPrimaryPrompt });
    await service.startMeeting({ sessionId: "meeting-msg" });

    const result = await service.sendMeetingMessage(
      "meeting-msg",
      "Please summarize the action items.",
    );

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-1");
    expect(result.responseText).toBe("Meeting follow-up sent.");
    expect(result.observedEventCount).toBe(2);
    expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);

    const session = tracker.getSessionById("meeting-msg");
    expect(
      (session?.messages || []).some((msg) =>
        String(msg?.content || "").includes("intermediate planning output")
      ),
    ).toBe(true);
    expect(
      (session?.messages || []).some((msg) =>
        String(msg?.content || "").includes("tool call finished")
      ),
    ).toBe(true);
  });

  it("sendMeetingMessage rejects inactive sessions unless explicitly allowed", async () => {
    const { service, tracker } = createHarness();
    await service.startMeeting({ sessionId: "meeting-archived" });
    tracker.updateSessionStatus("meeting-archived", "archived");

    await expect(
      service.sendMeetingMessage("meeting-archived", "Can we continue?"),
    ).rejects.toMatchObject({
      code: "MEETING_SESSION_INACTIVE",
    });
  });

  it("fetchMeetingTranscript returns deterministic pagination with session status", async () => {
    const { service, tracker, advanceClock } = createHarness();
    await service.startMeeting({ sessionId: "meeting-transcript" });

    tracker.recordEvent("meeting-transcript", {
      role: "user",
      content: "message-1",
      timestamp: new Date(1_700_000_000_000).toISOString(),
    });
    advanceClock(1000);
    tracker.recordEvent("meeting-transcript", {
      role: "assistant",
      content: "message-2",
      timestamp: new Date(1_700_000_001_000).toISOString(),
    });
    advanceClock(1000);
    tracker.recordEvent("meeting-transcript", {
      role: "system",
      content: "message-3",
      timestamp: new Date(1_700_000_002_000).toISOString(),
    });

    const pageOne = await service.fetchMeetingTranscript("meeting-transcript", {
      page: 1,
      pageSize: 2,
    });
    expect(pageOne.status).toBe("active");
    expect(pageOne.totalMessages).toBe(3);
    expect(pageOne.totalPages).toBe(2);
    expect(pageOne.messages).toHaveLength(2);
    expect(pageOne.hasNextPage).toBe(true);

    const pageTwo = await service.fetchMeetingTranscript("meeting-transcript", {
      page: 2,
      pageSize: 2,
    });
    expect(pageTwo.messages).toHaveLength(1);
    expect(pageTwo.messages[0].content).toBe("message-3");
    expect(pageTwo.hasNextPage).toBe(false);
    expect(pageTwo.hasPreviousPage).toBe(true);
  });

  it("analyzeMeetingFrame records vision summary and deduplicates repeated frames", async () => {
    const { service, tracker, analyzeVisionFrame } = createHarness();
    const frameDataUrl = "data:image/jpeg;base64,dGVzdA==";

    const first = await service.analyzeMeetingFrame(
      "meeting-vision",
      frameDataUrl,
      {
        source: "screen",
        width: 1920,
        height: 1080,
      },
    );
    expect(first.ok).toBe(true);
    expect(first.analyzed).toBe(true);
    expect(analyzeVisionFrame).toHaveBeenCalledTimes(1);

    const second = await service.analyzeMeetingFrame(
      "meeting-vision",
      frameDataUrl,
      { source: "screen" },
    );
    expect(second.analyzed).toBe(false);
    expect(second.reason).toBe("duplicate_frame");
    expect(analyzeVisionFrame).toHaveBeenCalledTimes(1);

    const session = tracker.getSessionById("meeting-vision");
    expect(
      (session?.messages || []).some((msg) =>
        String(msg?.content || "").startsWith("[Vision screen (1920x1080)]")
      ),
    ).toBe(true);
  });

  it("stopMeeting updates status and records a stop note", async () => {
    const { service, tracker } = createHarness();
    await service.startMeeting({ sessionId: "meeting-stop" });

    const stopped = await service.stopMeeting("meeting-stop", {
      status: "archived",
      note: "Meeting archived after handoff.",
    });

    expect(stopped.ok).toBe(true);
    expect(stopped.status).toBe("archived");
    expect(tracker.getSessionById("meeting-stop")?.status).toBe("archived");
    expect(
      (tracker.getSessionById("meeting-stop")?.messages || []).some((msg) =>
        String(msg?.content || "").includes("Meeting archived after handoff.")
      ),
    ).toBe(true);
  });
});

