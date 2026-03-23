import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../tui/app.mjs";
import AgentsScreen from "../../tui/screens/agents.mjs";
import StatusScreen from "../../tui/screens/status.mjs";
import TasksScreen from "../../tui/screens/tasks.mjs";
import {
  monitorStatsFixture,
  sessionDetailFixture,
  sessionDiffFixture,
  sessionsFixture,
  tasksFixture,
} from "./fixtures.mjs";
import { waitFor } from "./render-helpers.mjs";
import { renderInk } from "./render-ink.mjs";

function createMockBridge() {
  const listeners = new Map();
  return {
    host: "127.0.0.1",
    port: 3080,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event)?.delete(callback);
    },
    emit(event, payload) {
      for (const callback of listeners.get(event) || []) callback(payload);
    },
  };
}

describe("tui screen rendering", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/api/sessions?workspace=all")) {
        return { ok: true, json: async () => ({ ok: true, sessions: sessionsFixture }) };
      }
      if (href.includes("/api/retry-queue")) {
        return { ok: true, json: async () => ({ ok: true, ...monitorStatsFixture.retryQueue }) };
      }
      if (href.includes("/diff?workspace=all")) {
        return { ok: true, json: async () => sessionDiffFixture };
      }
      if (href.includes("/api/sessions/") && init.method !== "POST") {
        return { ok: true, json: async () => sessionDetailFixture };
      }
      if (href.includes("/api/sessions/") && init.method === "POST") {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: false, json: async () => ({ error: `Unhandled URL ${href}` }) };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the status screen with runtime metrics", async () => {
    const view = await renderInk(
      React.createElement(StatusScreen, {
        stats: monitorStatsFixture,
        sessions: sessionsFixture,
        tasks: tasksFixture,
      }),
      { columns: 220 },
    );

    expect(view.text()).toContain("Runtime Snapshot");
    expect(view.text()).toContain("Active Sessions: 1");
    expect(view.text()).toContain("Investigate failing build");

    await view.unmount();
  });

  it("renders the tasks screen with bucketed task counts", async () => {
    const view = await renderInk(
      React.createElement(TasksScreen, { tasks: tasksFixture }),
      { columns: 220 },
    );

    expect(view.text()).toContain("Task board view is read-only");
    expect(view.text()).toContain("todo (1)");
    expect(view.text()).toContain("Review PR #404");
    expect(view.text()).toContain("blocked (0)");

    await view.unmount();
  });

  it("renders the agents screen and loads the selected session logs", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(AgentsScreen, {
        wsBridge: bridge,
        host: "127.0.0.1",
        port: 3080,
        sessions: sessionsFixture,
        stats: monitorStatsFixture,
      }),
      { columns: 220 },
    );

    await waitFor(() => view.text().includes("Backoff queue (1)"));
    expect(view.text()).toContain("Investigate fa");

    await view.press("l");
    await waitFor(() => view.text().includes("Logs"));

    expect(view.text()).toContain("Loaded logs for session-");
    expect(view.text()).toContain("assistant");

    await view.unmount();
  });

  it("navigates app tabs with numeric key input", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient: bridge,
      }),
      { columns: 220 },
    );

    bridge.emit("connect", {});
    bridge.emit("stats", monitorStatsFixture);
    bridge.emit("sessions:update", { sessions: sessionsFixture });
    bridge.emit("task:create", tasksFixture[0]);
    await view.press(" ", 40);
    await waitFor(() => view.text().includes("Runtime Snapshot"));

    await view.press("2");
    await waitFor(() => view.text().includes("Task board view is read-only"));

    await view.press("3");
    await waitFor(() => view.text().includes("Backoff queue"));

    await view.unmount();
    expect(bridge.connect).toHaveBeenCalled();
    expect(bridge.disconnect).toHaveBeenCalled();
  });
});
