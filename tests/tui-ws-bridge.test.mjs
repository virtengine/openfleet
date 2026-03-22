import { describe, expect, it, vi } from "vitest";

import { TuiWsBridge } from "../tui/lib/ws-bridge.mjs";

describe("tui websocket bridge", () => {
  it("emits sessions:update snapshots to listeners", () => {
    const bridge = new TuiWsBridge({ host: "127.0.0.1", port: 3080 });
    const listener = vi.fn();

    bridge.on("sessions:update", listener);
    bridge._handleMessage({
      type: "sessions:update",
      payload: {
        sessions: [{ id: "session-1", status: "active" }],
      },
    });

    expect(listener).toHaveBeenCalledWith({
      sessions: [{ id: "session-1", status: "active" }],
    });
  });
});
