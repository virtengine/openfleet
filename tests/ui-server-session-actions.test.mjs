import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
  "BOSUN_ENV_NO_OVERRIDE",
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_TUNNEL",
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

    const created = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
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
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/pause?workspace=all`,
      { method: "POST" },
    ).then((response) => response.json());
    expect(pauseResponse.ok).toBe(true);

    const pausedSession = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`,
    ).then((response) => response.json());
    expect(pausedSession.session?.status).toBe("paused");

    const resumeResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=all`,
      { method: "POST" },
    ).then((response) => response.json());
    expect(resumeResponse.ok).toBe(true);

    const resumedSession = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`,
    ).then((response) => response.json());
    expect(resumedSession.session?.status).toBe("active");
  });

  it("normalizes wildcard and explicit workspace hints consistently across session routes", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "manual", prompt: "workspace matrix" }),
    }).then((response) => response.json());

    expect(created.ok).toBe(true);
    const sessionId = created.session?.id;
    const workspaceId = created.session?.metadata?.workspaceId;
    expect(sessionId).toBeTruthy();
    expect(workspaceId).toBeTruthy();

    const cases = [
      { name: "list-all", path: `/api/sessions?workspace=all`, method: "GET", status: 200 },
      { name: "list-wildcard", path: `/api/sessions?workspace=*`, method: "GET", status: 200 },
      { name: "list-explicit", path: `/api/sessions?workspace=${encodeURIComponent(workspaceId)}`, method: "GET", status: 200 },
      { name: "detail-all", path: `/api/sessions/${encodeURIComponent(sessionId)}?workspace=all`, method: "GET", status: 200 },
      { name: "detail-wildcard", path: `/api/sessions/${encodeURIComponent(sessionId)}?workspace=*`, method: "GET", status: 200 },
      { name: "detail-explicit", path: `/api/sessions/${encodeURIComponent(sessionId)}?workspace=${encodeURIComponent(workspaceId)}`, method: "GET", status: 200 },
      { name: "pause-wildcard", path: `/api/sessions/${encodeURIComponent(sessionId)}/pause?workspace=*`, method: "POST", status: 200 },
      { name: "resume-explicit", path: `/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=${encodeURIComponent(workspaceId)}`, method: "POST", status: 200 },
      { name: "stop-all", path: `/api/sessions/${encodeURIComponent(sessionId)}/stop?workspace=all`, method: "POST", status: 200 },
      { name: "delete-explicit", path: `/api/sessions/${encodeURIComponent(sessionId)}/delete?workspace=${encodeURIComponent(workspaceId)}`, method: "POST", status: 200 },
    ];

    for (const testCase of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, { method: testCase.method });
      const json = await response.json();
      expect(response.status, testCase.name).toBe(testCase.status);
      expect(json, testCase.name).toEqual(expect.objectContaining({ ok: true }));
      if (testCase.name.startsWith("list-")) {
        expect(Array.isArray(json.sessions), testCase.name).toBe(true);
        expect(json.sessions.some((session) => session.id === sessionId), testCase.name).toBe(true);
      }
    }
  });

  it("returns a predictable 400 for malformed session workspace hints", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "manual", prompt: "bad workspace hint" }),
    }).then((response) => response.json());

    expect(created.ok).toBe(true);
    const sessionId = created.session?.id;
    expect(sessionId).toBeTruthy();

    const cases = [
      { path: `/api/sessions/${encodeURIComponent(sessionId)}?workspace=../bad`, method: "GET" },
      { path: `/api/sessions/${encodeURIComponent(sessionId)}/pause?workspace=../bad`, method: "POST" },
      { path: `/api/sessions?workspace=bad/value`, method: "GET" },
      { path: `/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=bad/value`, method: "POST" },
      { path: `/api/sessions/${encodeURIComponent(sessionId)}/delete?workspace=%2Fbad`, method: "POST" },
    ];

    for (const testCase of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${testCase.path}`, { method: testCase.method });
      const json = await response.json();
      expect(response.status).toBe(400);
      expect(json).toEqual(expect.objectContaining({ ok: false, error: "Malformed workspace hint" }));
    }
  });
});
