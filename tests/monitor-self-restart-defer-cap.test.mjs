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

  it("force-stops active internal agents when count or time hard cap is reached", () => {
    const hardCapBlock = monitorSource.match(
      /if \(hitCountCap \|\| hitTimeCap\) \{[\s\S]*?internalTaskExecutor\.stop\(\)\.catch\(\(\) => \{\}\);[\s\S]*?selfRestartForSourceChange\(filename\);[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(
      hardCapBlock,
      "monitor should force-stop stuck internal task agents at defer hard caps",
    ).toBeTruthy();
  });
});
