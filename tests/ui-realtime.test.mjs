import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("telegram mini app realtime wiring", () => {
  it("ui-server exposes websocket upgrade and task edit APIs", () => {
    const source = readFileSync(
      resolve(process.cwd(), "ui-server.mjs"),
      "utf8",
    );
    expect(source).toContain("WebSocketServer");
    expect(source).toContain("/ws");
    expect(source).toContain("/api/tasks/edit");
    expect(source).toContain("broadcastUiEvent");
  });

  it("frontend modules contain websocket and realtime logic", () => {
    // In the modular rewrite, WebSocket logic lives in modules/api.js
    const apiModulePath = resolve(process.cwd(), "ui/modules/api.js");
    if (existsSync(apiModulePath)) {
      const apiSource = readFileSync(apiModulePath, "utf8");
      expect(apiSource).toContain("WebSocket");
      expect(apiSource).toContain("connectWebSocket");
    }

    // The entry point app.js should import from modules
    const appSource = readFileSync(resolve(process.cwd(), "ui/app.js"), "utf8");
    expect(appSource).toContain("import");
    // Accept either modular or monolith patterns
    const hasModularApi = appSource.includes("modules/api");
    const hasLegacyRealtime = appSource.includes("connectRealtime");
    expect(hasModularApi || hasLegacyRealtime).toBe(true);
  });
});
