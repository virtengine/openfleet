import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
  "BOSUN_ENV_NO_OVERRIDE",
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_TUNNEL",
  "NODE_TLS_REJECT_UNAUTHORIZED",
];

describe("ui-server session actions", () => {
  let envSnapshot = {};

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
  });

  afterEach(async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.stopTelegramUiServer();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  it("pauses and resumes a session through the HTTP session routes", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const baseUrl = String(mod.getTelegramUiUrl() || `http://127.0.0.1:${port}`).trim();
    if (baseUrl.startsWith("https://")) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    const apiUrl = (path) => new URL(path, `${baseUrl}/`).toString();

    const created = await fetch(apiUrl("/api/sessions/create"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "manual",
        prompt: "pause route regression",
      }),
    }).then((response) => response.json());

    expect(created.ok).toBe(true);
    const sessionId = created.session?.id;
    expect(sessionId).toBeTruthy();

    const pauseResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/pause?workspace=all`),
      { method: "POST" },
    ).then((response) => response.json());
    expect(pauseResponse.ok).toBe(true);

    const pausedSession = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`),
    ).then((response) => response.json());
    expect(pausedSession.session?.status).toBe("paused");

    const resumeResponse = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=all`),
      { method: "POST" },
    ).then((response) => response.json());
    expect(resumeResponse.ok).toBe(true);

    const resumedSession = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`),
    ).then((response) => response.json());
    expect(resumedSession.session?.status).toBe("active");
  }, 15000);

  it("exports a diagnostics bundle for the requested session", async () => {
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const taskStore = await import("../task/task-store.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const baseUrl = String(mod.getTelegramUiUrl() || `http://127.0.0.1:${port}`).trim();
    if (baseUrl.startsWith("https://")) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    const apiUrl = (path) => new URL(path, `${baseUrl}/`).toString();

    taskStore.createTask({
      id: "TASK-DIAG-1",
      title: "Diagnostics export",
      status: "inprogress",
      branch: "task/TASK-DIAG-1-export",
      workflowRuns: [
        {
          runId: "run-diag-1",
          workflowId: "wf-diag-1",
          status: "completed",
          primarySessionId: "session-diag-1",
          issueAdvisor: {
            recommendedAction: "resume_remaining",
            summary: "Resume from Agent Plan.",
          },
        },
      ],
    });
    await taskStore.waitForStoreWrites();

    const tracker = getSessionTracker();
    tracker.createSession({
      id: "session-diag-1",
      type: "task",
      taskId: "TASK-DIAG-1",
      metadata: {
        title: "Diagnostics export",
        workflowId: "wf-diag-1",
        workflowName: "Diagnostics Flow",
        branch: "task/TASK-DIAG-1-export",
      },
    });
    tracker.appendEvent("session-diag-1", {
      role: "assistant",
      type: "agent_message",
      content: "Collected diagnostics context.",
      timestamp: "2026-03-04T01:00:00.000Z",
      meta: {
        usage: {
          input_tokens: 1000,
          output_tokens: 250,
          total_tokens: 1250,
        },
      },
    });

    const diagnostics = await fetch(
      apiUrl("/api/sessions/session-diag-1/diagnostics?workspace=all"),
    ).then((response) => response.json());

    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.data?.schemaVersion).toBe(1);
    expect(diagnostics.data?.session?.id).toBe("session-diag-1");
    expect(diagnostics.data?.session?.tokenUsage?.totalTokens).toBe(1250);
    expect(diagnostics.data?.linked?.task?.id).toBe("TASK-DIAG-1");
    expect(diagnostics.data?.linked?.workflowRuns?.[0]).toMatchObject({
      runId: "run-diag-1",
      workflowId: "wf-diag-1",
    });
  }, 15000);
});
