import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("windows hidden child process policy", () => {
  it("installs a Windows child_process shim that defaults windowsHide to true", () => {
    const source = readFileSync(
      resolve(process.cwd(), "infra/windows-hidden-child-processes.mjs"),
      "utf8",
    );
    expect(source).toContain("syncBuiltinESMExports");
    expect(source).toContain("windowsHide: true");
    expect(source).toContain("patchedSpawn");
    expect(source).toContain("patchedExec");
  });
});
