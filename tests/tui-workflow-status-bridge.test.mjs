import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("tui workflow status bridge architecture", () => {
  it("forwards workflow status events through the UI websocket broadcast path", () => {
    const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
    const uiServerSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

    expect(monitorSource).toContain("workflow:status");
    expect(uiServerSource).toContain('broadcastUiEvent(["workflows", "tui"], "workflow:status"');
  });
});
