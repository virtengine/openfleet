import Ajv from "ajv";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetSingleton, createSession, getSessionTracker, updateSessionStatus } from "../infra/session-tracker.mjs";
import { TUI_EVENT_SCHEMAS } from "../infra/tui-bridge.mjs";
import { startTelegramUiServer, stopTelegramUiServer } from "../server/ui-server.mjs";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateMonitorStats = ajv.compile(TUI_EVENT_SCHEMAS["monitor:stats"]);
const validateSessionsUpdate = ajv.compile(TUI_EVENT_SCHEMAS["sessions:update"]);
const validateSessionEvent = ajv.compile(TUI_EVENT_SCHEMAS["session:event"]);

function waitForWsOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function createMessageCollector(socket) {
  const messages = [];
  socket.on("message", (raw) => {
    try {
      messages.push(JSON.parse(String(raw)));
    } catch {
      // ignore malformed frames in test helper
    }
  });

  return function waitForMessage(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const existing = messages.find((entry) => predicate(entry));
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
      const interval = setInterval(() => {
        const match = messages.find((entry) => predicate(entry));
        if (!match) return;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(match);
      }, 25);
    });
  };
}

describe("ui-server TUI websocket", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_UI_TUNNEL",
    "BOSUN_ENV_NO_OVERRIDE",
    "BOSUN_HOME",
    "BOSUN_DIR",
    "BOSUN_CONFIG_PATH",
  ];
  let envSnapshot = {};
  let tmpDir = "";

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_STATS_BROADCAST_MS = "50";
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-tui-ws-"));
    process.env.BOSUN_HOME = tmpDir;
    process.env.BOSUN_DIR = tmpDir;
    writeFileSync(join(tmpDir, "bosun.config.json"), JSON.stringify({}), "utf8");
    _resetSingleton({ persistDir: null });
  });

  afterEach(() => {
    stopTelegramUiServer();
    _resetSingleton({ persistDir: null });
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts the shared UI token and emits initial plus live TUI events", async () => {
    const server = await startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
      dependencies: { configDir: tmpDir },
    });
    const port = server.address().port;
    const compatTokenPath = join(tmpDir, ".cache", "ui-token");
    expect(existsSync(compatTokenPath)).toBe(true);

    const token = String(readFileSync(compatTokenPath, "utf8")).trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/i);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const waitForMessage = createMessageCollector(socket);
    await waitForWsOpen(socket);

    const sessionsSnapshot = await waitForMessage((message) => message?.type === "sessions:update");
    expect(Array.isArray(sessionsSnapshot.payload)).toBe(true);
    expect(validateSessionsUpdate(sessionsSnapshot.payload), JSON.stringify(validateSessionsUpdate.errors || [])).toBe(true);

    const statsMessage = await waitForMessage((message) => message?.type === "monitor:stats");
    expect(validateMonitorStats(statsMessage.payload), JSON.stringify(validateMonitorStats.errors || [])).toBe(true);

    const nextStatsMessage = await waitForMessage(
      (message) => message?.type === "monitor:stats"
        && Number(message?.ts || 0) > Number(statsMessage.ts || 0),
      5000,
    );
    expect(validateMonitorStats(nextStatsMessage.payload), JSON.stringify(validateMonitorStats.errors || [])).toBe(true);
    expect(Number(nextStatsMessage.ts || 0)).toBeGreaterThan(Number(statsMessage.ts || 0));

    await createSession({
      id: "task-ws-1",
      taskId: "task-ws-1",
      metadata: { title: "WS task" },
    });
    const createdSnapshot = await waitForMessage(
      (message) => message?.type === "sessions:update"
        && Array.isArray(message?.payload)
        && message.payload.some((entry) => entry.id === "task-ws-1"),
    );
    expect(createdSnapshot.payload.some((entry) => entry.id === "task-ws-1")).toBe(true);
    expect(validateSessionsUpdate(createdSnapshot.payload), JSON.stringify(validateSessionsUpdate.errors || [])).toBe(true);

    getSessionTracker().recordEvent("task-ws-1", {
      role: "assistant",
      content: "hello from ws",
      timestamp: new Date().toISOString(),
    });
    const sessionEvent = await waitForMessage(
      (message) => message?.type === "session:event" && message?.payload?.sessionId === "task-ws-1",
    );
    expect(sessionEvent.payload.message.content).toContain("hello from ws");
    expect(validateSessionEvent(sessionEvent.payload), JSON.stringify(validateSessionEvent.errors || [])).toBe(true);

    updateSessionStatus("task-ws-1", "completed");
    const completedSnapshot = await waitForMessage(
      (message) => message?.type === "sessions:update"
        && Array.isArray(message?.payload)
        && message.payload.some((entry) => entry.id === "task-ws-1" && entry.status === "completed"),
    );
    expect(completedSnapshot.payload.some((entry) => entry.id === "task-ws-1" && entry.status === "completed")).toBe(true);
    expect(validateSessionsUpdate(completedSnapshot.payload), JSON.stringify(validateSessionsUpdate.errors || [])).toBe(true);

    socket.close();
  }, 15000);
});

