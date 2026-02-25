import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor self-restart defer hard cap", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

  it("defaults SELF_RESTART_DEFER_HARD_CAP to 20", () => {
    expect(monitorSource).toContain('process.env.SELF_RESTART_DEFER_HARD_CAP || "20"');
  });

  it("force-stops active internal agents when defer hard cap is reached", () => {
    const hardCapBlock = monitorSource.match(
      /if \(deferCount >= SELF_RESTART_DEFER_HARD_CAP\) \{[\s\S]*?internalTaskExecutor\.stop\(\)\.catch\(\(\) => \{\}\);[\s\S]*?selfRestartForSourceChange\(filename\);[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(hardCapBlock, "monitor should force-stop stuck internal task agents at defer hard cap").toBeTruthy();
  });
});
