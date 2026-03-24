import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TuiWsBridge, buildTuiHttpUrl, resolveWebSocketProtocol } from "../tui/lib/ws-bridge.mjs";

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

  it("builds HTTP URLs that match the websocket host and protocol", () => {
    expect(buildTuiHttpUrl({ host: "127.0.0.1", port: 3080, path: "/api/tasks/create" })).toBe(
      "http://127.0.0.1:3080/api/tasks/create",
    );
    expect(buildTuiHttpUrl({ host: "example.com", port: 443, path: "api/tasks/create", protocol: "wss" })).toBe(
      "https://example.com/api/tasks/create",
    );
  });

  it("posts task creation requests with the shared bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ ok: true, data: { id: "task-1", title: "Demo" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new TuiWsBridge({ host: "127.0.0.1", port: 3080, configDir: "C:/tmp/missing" });
    const originalEnv = process.env.BOSUN_UI_TOKEN;
    process.env.BOSUN_UI_TOKEN = "1234567890123456789012345678901234567890123456789012345678901234";

    try {
      const created = await bridge.createTask({ title: "Demo", priority: "high" });
      expect(created).toEqual({ id: "task-1", title: "Demo" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:3080/api/tasks/create");
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe(
        "Bearer 1234567890123456789012345678901234567890123456789012345678901234",
      );
      expect(options.body).toBe(JSON.stringify({ title: "Demo", priority: "high" }));
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BOSUN_UI_TOKEN;
      } else {
        process.env.BOSUN_UI_TOKEN = originalEnv;
      }
      vi.unstubAllGlobals();
    }
  });
});
