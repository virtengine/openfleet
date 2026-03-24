import { describe, expect, it, vi } from "vitest";

import { TuiWsBridge } from "../tui/lib/ws-bridge.mjs";

describe("tui websocket bridge", () => {
  it("normalizes sessions:update snapshots to arrays", () => {
    const bridge = new TuiWsBridge({ host: "127.0.0.1", port: 3080 });
    const listener = vi.fn();

    bridge.on("sessions:update", listener);
    bridge._handleMessage({
      type: "sessions:update",
      payload: [{ id: "session-1", status: "active" }],
    });

    bridge._handleMessage({
      type: "sessions:update",
      payload: {
        sessions: [{ id: "session-2", status: "completed" }],
      },
    });

    expect(listener).toHaveBeenNthCalledWith(1, [{ id: "session-1", status: "active" }]);
    expect(listener).toHaveBeenNthCalledWith(2, [{ id: "session-2", status: "completed" }]);
  });
});
