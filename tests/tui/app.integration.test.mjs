import React from "react";
import { describe, expect, it } from "vitest";

import App from "../../tui/app.mjs";
import { FIXTURE_SESSIONS, FIXTURE_STATS, FIXTURE_TASKS, createMockWsClient } from "./fixtures.mjs";
import { renderInk } from "./render-ink.mjs";

describe("tui app integration", () => {
  it("navigates between screens and applies websocket updates through the injected client", async () => {
    const wsClient = createMockWsClient();

    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient,
      }),
      { columns: 220 },
    );

    wsClient.emit("connect", {});
    wsClient.emit("stats", FIXTURE_STATS);
    wsClient.emit("sessions:update", { sessions: FIXTURE_SESSIONS });
    wsClient.emit("tasks:update", {
      reason: "task-created",
      sourceEvent: "task:created",
      patch: FIXTURE_TASKS[0],
    });

    await view.press(" ", 40);
    expect(view.text()).toContain("Connected");
    expect(view.text()).toContain("Runtime Snapshot");

    await view.press("2");
    expect(view.text()).toContain("Task board view is read-only");

    wsClient.emit("task:create", FIXTURE_TASKS[4]);
    await view.press(" ", 40);
    expect(view.text()).toContain("Ship smoke test");

    await view.press("3");
    expect(view.text()).toContain("Backoff queue");
    expect(view.text()).toContain("Synthesized failing smoke test");

    await view.unmount();
    expect(wsClient.connectCalled).toBe(1);
    expect(wsClient.disconnectCalled).toBe(1);
  });
});