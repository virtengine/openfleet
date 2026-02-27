import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("logger benign stream error handling", () => {
  const source = readFileSync(resolve(process.cwd(), "lib/logger.mjs"), "utf8");

  it("does not write benign stderr stream breaks to error log", () => {
    expect(source).not.toContain("stderr error: ${err?.message || err}");
    expect(source).toContain("stderr stream closed");
  });

  it("does not write benign stdout stream breaks to error log", () => {
    expect(source).not.toContain("stdout error: ${err?.message || err}");
    expect(source).toContain("stdout stream closed");
  });
});
