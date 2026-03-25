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
    await waitFor(() => !view.text().includes("Command Palette"));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/MT-734/kill?workspace=all"),
      expect.anything(),
    );

    await view.unmount();
  });
});