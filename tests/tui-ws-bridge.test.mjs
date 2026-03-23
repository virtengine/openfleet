import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TuiWsBridge, resolveWebSocketProtocol } from "../tui/lib/ws-bridge.mjs";

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

  it("infers wss from the persisted UI instance lock", () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-tui-lock-"));
    try {
      const cacheDir = join(configDir, ".cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "ui-server.instance.lock.json"), JSON.stringify({ protocol: "https" }), "utf8");

      expect(resolveWebSocketProtocol({ configDir })).toBe("wss");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
