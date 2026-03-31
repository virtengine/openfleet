import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../tui/app.mjs";
import { FIXTURE_SESSIONS, FIXTURE_STATS, FIXTURE_TASKS, createMockWsClient } from "./fixtures.mjs";
import { renderInk } from "./render-ink.mjs";
import { waitFor } from "./render-helpers.mjs";

describe("command palette integration", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/api/workflows/templates")) {
        return { ok: true, json: async () => ([{ id: "tpl-1", name: "Health Check" }]) };
      }
      if (href.includes("/api/tasks") && !href.includes("create") && !href.includes("update")) {
        return { ok: true, json: async () => ({ tasks: FIXTURE_TASKS }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("opens with Ctrl+P, shows matches, and executes the selected action", async () => {
    const wsClient = createMockWsClient();

    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient,
        historyAdapter: { load: async () => [], save: async () => {} },
      }),
      { columns: 220 },
    );

    wsClient.emit("connect", {});
    wsClient.emit("stats", FIXTURE_STATS);
    wsClient.emit("sessions:update", { sessions: FIXTURE_SESSIONS.map((item) => ({ ...item, id: "MT-734" })) });

    await view.press("\u0010");
    await waitFor(() => view.text().includes("Command Palette"));

    await view.press("kill");
    await waitFor(() => view.text().includes("Kill MT-734"));

    await view.press("\r");
    await waitFor(() => !view.latestText().includes("Command Palette"));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/MT-734/kill?workspace=all"),
      expect.anything(),
    );

    await view.unmount();
  });

  it("opens with : only when screen input is not locked", async () => {
    const wsClient = createMockWsClient();

    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient,
        historyAdapter: { load: async () => [], save: async () => [] },
      }),
      { columns: 220 },
    );

    await view.press(":");
    await waitFor(() => view.text().includes("Command Palette"));
    await view.press("\u001b");
    await waitFor(() => !view.latestText().includes("Command Palette"));

    const lockedView = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "tasks",
        refreshMs: 2000,
        wsClient,
        historyAdapter: { load: async () => [], save: async () => [] },
      }),
      { columns: 220 },
    );

    await waitFor(() => lockedView.text().includes("Tasks"));
    await lockedView.press("n");
    await waitFor(() => lockedView.lastFrame()?.includes("New Task"));
    await lockedView.press(":");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lockedView.text().includes("Command Palette")).toBe(false);
    await lockedView.press("\u0010");
    await waitFor(() => lockedView.text().includes("Command Palette"));

    await view.unmount();
    await lockedView.unmount();
  });

  it("shows recent actions when opened empty and closes cleanly on escape", async () => {
    const wsClient = createMockWsClient();
    const save = vi.fn(async ({ actionId, recentActionIds }) => [actionId, ...recentActionIds].slice(0, 10));

    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient,
        historyAdapter: { load: async () => ["session:kill:MT-734"], save },
      }),
      { columns: 220 },
    );

    wsClient.emit("connect", {});
    wsClient.emit("stats", FIXTURE_STATS);
    wsClient.emit("sessions:update", { sessions: FIXTURE_SESSIONS.map((item) => ({ ...item, id: "MT-734" })) });

    await view.press("\u0010");
    await waitFor(() => view.text().includes("Recent actions"));
    expect(view.text()).toContain("Kill MT-734");

    const beforeClose = view.lastFrame();
    await view.press("\u001b");
    await waitFor(() => !view.latestText().includes("Command Palette"));
    expect(view.lastFrame()).not.toContain("Recent actions");
    expect(view.lastFrame()).not.toBe(beforeClose);

    await view.press("\u0010");
    await waitFor(() => view.text().includes("Command Palette"));
    await view.press("\r");
    await waitFor(() => !view.latestText().includes("Command Palette"));
    expect(save).toHaveBeenCalledWith({
      actionId: "session:kill:MT-734",
      recentActionIds: ["session:kill:MT-734"],
    });

    await view.unmount();
  });
});
