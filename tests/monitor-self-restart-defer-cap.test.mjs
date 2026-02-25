import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor self-restart defer hard caps", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

  it("defaults SELF_RESTART_DEFER_HARD_CAP to 20", () => {
    expect(monitorSource).toContain('process.env.SELF_RESTART_DEFER_HARD_CAP || "20"');
  });

  it("defines a max deferred-time cap", () => {
    expect(monitorSource).toContain('process.env.SELF_RESTART_MAX_DEFER_MS || "600000"');
  });

  it("forces restart path at hard cap with active-agent override", () => {
    expect(monitorSource).toContain(
      "selfRestartForSourceChange(filename, { forceActiveAgentExit: true });",
    );
    expect(monitorSource).toContain("if (activeSlots > 0 && !forceActiveAgentExit)");
    expect(monitorSource).toContain(
      "FORCED self-restart: proceeding with ${activeSlots} active agent(s) after defer hard cap",
    );
  });
});

