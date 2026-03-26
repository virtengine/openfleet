import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("portal websocket connection badge", () => {
  it("tracks explicit websocket badge signals and reconnect metadata", () => {
    const apiSource = readFileSync(resolve(process.cwd(), "ui/modules/api.js"), "utf8");

    expect(apiSource).toContain("wsStatus = signal");
    expect(apiSource).toContain("wsLastReconnectAt = signal");
    expect(apiSource).toContain("'connected'");
    expect(apiSource).toContain("'reconnecting'");
    expect(apiSource).toContain("'offline'");
    expect(apiSource).toContain('wsLastReconnectAt.value = Date.now()');
    expect(apiSource).not.toContain('wsStatus.value = "reconnecting";\n    wsLastReconnectAt.value = Date.now()');
  });

  it("renders a connection badge in the portal header before settings", () => {
    const appSource = readFileSync(resolve(process.cwd(), "ui/app.js"), "utf8");

    expect(appSource).toContain("function ConnectionBadge()");
    expect(appSource).toContain("connection-badge");
    expect(appSource).toContain("<${ConnectionBadge} />");
    expect(appSource).toContain("last reconnect");
    expect(appSource).toContain("Reconnecting...");
  });

  it("defines themed badge color css variables and pulse animation", () => {
    const stylesSource = readFileSync(resolve(process.cwd(), "ui/styles.css"), "utf8");

    expect(stylesSource).toContain("--ws-badge-connected");
    expect(stylesSource).toContain("--ws-badge-reconnecting");
    expect(stylesSource).toContain("--ws-badge-offline");
    expect(stylesSource).toContain("connection-badge-dot");
    expect(stylesSource).toContain("connection-badge-pulse");
  });
});
