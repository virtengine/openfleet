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
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Need approval", checkpointId: `${sessionId}:approval-1` }),
      },
    ).then((response) => response.json());
    expect(pauseResponse.ok).toBe(true);
    expect(pauseResponse.approvalState?.status).toBe("pending");

    const blockedResume = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=all`,
      { method: "POST" },
    );
    expect(blockedResume.status).toBe(409);

    const approvalResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/approval?workspace=all`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: true, resolvedBy: "test-user", resolutionToken: "token-1" }),
      },
    ).then((response) => response.json());
    expect(approvalResponse.ok).toBe(true);
    expect(approvalResponse.duplicate).toBe(false);
    expect(approvalResponse.approvalState?.status).toBe("approved");

    const duplicateApproval = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/approval?workspace=all`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: true, resolvedBy: "test-user", resolutionToken: "token-1" }),
      },
    ).then((response) => response.json());
    expect(duplicateApproval.ok).toBe(true);
    expect(duplicateApproval.duplicate).toBe(true);
    expect(duplicateApproval.approvalState?.callbackCount).toBe(2);

    const resumed = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/resume?workspace=all`,
      { method: "POST" },
    ).then((response) => response.json());
    expect(resumed.ok).toBe(true);
    expect(resumed.resumedFromApproval).toBe(true);

    const resumedSession = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`,
    ).then((response) => response.json());
    expect(resumedSession.session?.status).toBe("active");
    expect(resumedSession.session?.approvalState?.status).toBe("approved");
  });
});

