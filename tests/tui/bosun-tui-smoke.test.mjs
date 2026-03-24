import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("bosun-tui smoke", () => {
  it("fails cleanly in a non-tty environment", () => {
    const result = spawnSync(process.execPath, ["bosun-tui.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_NO_TTY: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stdout is not a TTY");
    expect(result.stderr).not.toContain("Unhandled");
  });
});
