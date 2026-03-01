import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../voice-relay.mjs", () => ({
  analyzeVisionFrame: vi.fn(async () => ({
    summary: "Editor with a failing test output is visible.",
    provider: "mock",
    model: "mock-vision-model",
  })),
}));

const { analyzeVisionFrame } = await import("../voice-relay.mjs");

describe("ui-server voice + vision routes", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_UI_TUNNEL",
    "TELEGRAM_UI_PORT",
    "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
    "BOSUN_UI_AUTO_OPEN_BROWSER",
    "BOSUN_ENV_NO_OVERRIDE",
    "WORKFLOW_DEFAULT_AUTOINSTALL",
    "WORKFLOW_AUTOMATION_ENABLED",
    "WORKFLOW_EVENT_DEDUP_WINDOW_MS",
  ];
  let envSnapshot = {};

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
    process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "0";
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.WORKFLOW_DEFAULT_AUTOINSTALL = "false";
    process.env.WORKFLOW_AUTOMATION_ENABLED = "true";
    process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS = "1";
    vi.mocked(analyzeVisionFrame).mockClear();
  });

  afterEach(async () => {
    const mod = await import("../ui-server.mjs");
    mod.stopTelegramUiServer();
    // Reset session tracker singleton so test-created sessions don't leak
    // into subsequent tests or persist to disk.
    const { _resetSingleton } = await import("../session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  async function startServer() {
    const mod = await import("../ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      host: "127.0.0.1",
      port: 0,
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    return { port };
  }

  it("persists transcript turns into the bound session history", async () => {
    const { port } = await startServer();
    const sessionId = `primary-voice-http-${Date.now()}`;

    const res = await fetch(`http://127.0.0.1:${port}/api/voice/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        role: "user",
        content: "Please check my build logs.",
        executor: "codex-sdk",
        mode: "agent",
      }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    const { getSessionById } = await import("../session-tracker.mjs");
    const session = getSessionById(sessionId);
    expect(session).toBeTruthy();
    const latest = (session?.messages || []).at(-1);
    expect(latest?.role).toBe("user");
    expect(latest?.content).toContain("check my build logs");
  }, 20_000);

  it("queues workflow trigger evaluation for transcript and wake phrase events", async () => {
    const { port } = await startServer();
    const sessionId = `primary-workflow-transcript-${Date.now()}`;
    const { getWorkflowEngine } = await import("../workflow-engine.mjs");
    const engine = getWorkflowEngine();
    const evaluateSpy = vi.spyOn(engine, "evaluateTriggers").mockResolvedValue([]);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/voice/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          role: "user",
          content: "Hi bosun wake, can you capture this action item?",
          eventType: "wake_phrase",
          provider: "mock-provider",
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);

      await vi.waitFor(() => {
        expect(evaluateSpy).toHaveBeenCalledWith(
          "meeting.transcript",
          expect.objectContaining({
            sessionId,
            meetingSessionId: sessionId,
            role: "user",
            content: "Hi bosun wake, can you capture this action item?",
            source: "voice",
            transcriptEventType: "wake_phrase",
            _triggerSource: "ui-server",
            _triggerEventType: "meeting.transcript",
          }),
        );
      });

      await vi.waitFor(() => {
        expect(evaluateSpy).toHaveBeenCalledWith(
          "meeting.wake_phrase",
          expect.objectContaining({
            sessionId,
            role: "user",
            transcriptEventType: "wake_phrase",
            _triggerSource: "ui-server",
            _triggerEventType: "meeting.wake_phrase",
          }),
        );
      });
    } finally {
      evaluateSpy.mockRestore();
    }
  });

  it("ingests a vision frame, analyzes once, and deduplicates repeated frames", async () => {
    const { port } = await startServer();
    const sessionId = `primary-vision-http-${Date.now()}`;
    const frameDataUrl = "data:image/jpeg;base64,dGVzdA==";

    const first = await fetch(`http://127.0.0.1:${port}/api/vision/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        source: "screen",
        frameDataUrl,
        width: 1280,
        height: 720,
      }),
    });
    const firstJson = await first.json();
    expect(first.status).toBe(200);
    expect(firstJson.ok).toBe(true);
    expect(firstJson.analyzed).toBe(true);
    expect(firstJson.summary).toContain("failing test");
    expect(vi.mocked(analyzeVisionFrame)).toHaveBeenCalledTimes(1);

    const second = await fetch(`http://127.0.0.1:${port}/api/vision/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        source: "screen",
        frameDataUrl,
        width: 1280,
        height: 720,
      }),
    });
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.ok).toBe(true);
    expect(secondJson.analyzed).toBe(false);
    expect(secondJson.reason).toBe("duplicate_frame");
    expect(vi.mocked(analyzeVisionFrame)).toHaveBeenCalledTimes(1);

    const { getSessionById } = await import("../session-tracker.mjs");
    const session = getSessionById(sessionId);
    expect(session).toBeTruthy();
    const visionMessage = (session?.messages || []).find(
      (msg) => String(msg?.content || "").startsWith("[Vision screen"),
    );
    expect(visionMessage).toBeTruthy();
  });
});
