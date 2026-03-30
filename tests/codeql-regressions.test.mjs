import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CodeQL regressions", () => {
  it("keeps local probes on default TLS validation", () => {
    const heartbeatSource = readFileSync(resolve(process.cwd(), "infra/heartbeat-monitor.mjs"), "utf8");
    const uiServerSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

    expect(heartbeatSource).not.toContain("rejectUnauthorized: false");
    expect(uiServerSource).not.toContain("rejectUnauthorized: false");
  });

  it("avoids shell-built keychain commands and regex glob extraction", () => {
    const vaultSource = readFileSync(resolve(process.cwd(), "lib/vault-keychain.mjs"), "utf8");
    const mcpSource = readFileSync(resolve(process.cwd(), "server/bosun-mcp-server.mjs"), "utf8");

    expect(vaultSource).toContain("execFileSync");
    expect(vaultSource).not.toContain("powershell -NoProfile -NonInteractive -Command");
    expect(vaultSource).not.toContain("security find-generic-password -s");
    expect(vaultSource).not.toContain("secret-tool lookup service");
    expect(mcpSource).not.toContain("pattern.replace(/.*\\\\*\\./, \"\")");
  });
});
