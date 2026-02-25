import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor-monitor prompt orchestrator tail", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

  it("marks orchestrator tail as not applicable in internal executor mode", () => {
    expect(monitorSource).toContain('execMode !== "internal" && !isExecutorDisabled()');
    expect(monitorSource).toContain(
      'not applicable: executor mode "${execMode}" runs without external orchestrator logs',
    );
  });
  it("writes an explicit active-log placeholder when orchestrator is skipped", () => {
    expect(monitorSource).toContain(
      '[monitor] orchestrator inactive in executor mode "${execMode}" (backend=${backend})',
    );
    expect(monitorSource).toContain(
      'await writeFile(activeLogPath, `${message}\\n`, "utf8")',
    );
  });
});

