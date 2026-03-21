import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSingleton as resetSessionTracker, getSessionTracker } from "../infra/session-tracker.mjs";
import { resolveTuiAuthToken, TUI_EVENT_SCHEMAS } from "../infra/tui-bridge.mjs";

function waitFor(condition, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        const value = condition();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for condition"));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, intervalMs);
    timer.unref?.();
  });
}

describe("ui-server TUI websocket bridge", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_UI_TUNNEL",
    "BOSUN_STATS_BROADCAST_MS",
    "BOSUN_ENV_NO_OVERRIDE",
  ];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateStats = ajv.compile(TUI_EVENT_SCHEMAS["monitor:stats"]);
  const validateSessions = ajv.compile(TUI_EVENT_SCHEMAS["sessions:update"]);
  const validateSessionEvent = ajv.compile(TUI_EVENT_SCHEMAS["session:event"]);

  let envSnapshot = {};
  let configDir = "";

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_STATS_BROADCAST_MS = "25";
    configDir = mkdtempSync(join(tmpdir(), "bosun-ui-tui-ws-"));
    resetSessionTracker({ persistDir: null });
  });

  afterEach(async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.stopTelegramUiServer();
    resetSessionTracker({ persistDir: null });
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  it("persists a shared auth token and emits canonical snapshot events", async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      configDir,
      getInternalExecutor: () => ({
        getStatus: () => ({
          activeSlots: 2,
          maxParallel: 5,
          slots: [{ id: "slot-1" }, { id: "slot-2" }],
        }),
      }),
      getTuiMonitorStats: () => ({
        activeAgents: 2,
        maxAgents: 5,
        tokensIn: 150,
        tokensOut: 50,
        throughputTps: 10,
        rateLimits: {
          openai: { primary: 1000, secondary: 500, credits: 200, unit: "tokens/min" },
        },
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const token = mod.getSessionToken();

    expect(readFileSync(join(configDir, ".cache", "ui-token"), "utf8").trim()).toBe(token);
    expect(resolveTuiAuthToken({ configDir })).toBe(token);

    const messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const sessionsUpdate = await waitFor(() => messages.find((message) => message.type === "sessions:update"));
    expect(validateSessions(sessionsUpdate.payload), JSON.stringify(validateSessions.errors || [])).toBe(true);

    const monitorStats = await waitFor(() => messages.find((message) => message.type === "monitor:stats"));
    expect(validateStats(monitorStats.payload), JSON.stringify(validateStats.errors || [])).toBe(true);

    const secondMonitorStats = await waitFor(() => messages.filter((message) => message.type === "monitor:stats")[1]);
    expect(secondMonitorStats.ts).toBeGreaterThanOrEqual(monitorStats.ts);
    expect(validateStats(secondMonitorStats.payload), JSON.stringify(validateStats.errors || [])).toBe(true);

    ws.close();
  });

  it("emits canonical session events for message activity", async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({ configDir });

    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const token = mod.getSessionToken();

    const messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)));
    });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const tracker = getSessionTracker({ persistDir: null });
    tracker.startSession("task-1", "Task 1");
    tracker.recordEvent("task-1", { role: "assistant", content: "hello from tui bridge" });

    const sessionEvent = await waitFor(() => messages.find((message) => message.type === "session:event" && message.payload?.taskId === "task-1" && message.payload?.event?.kind === "message"));
    const sessionsUpdate = await waitFor(() => messages.find((message) => message.type === "sessions:update" && Array.isArray(message.payload) && message.payload.some((session) => session.taskId === "task-1")));

    expect(validateSessionEvent(sessionEvent.payload), JSON.stringify(validateSessionEvent.errors || [])).toBe(true);
    expect(validateSessions(sessionsUpdate.payload), JSON.stringify(validateSessions.errors || [])).toBe(true);

    ws.close();
  });
});
