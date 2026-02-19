import { describe, expect, it } from "vitest";
import { parseEnvBoolean } from "../config.mjs";

describe("config boolean env parser", () => {
  it("parses true-like values", () => {
    expect(parseEnvBoolean("true", false)).toBe(true);
    expect(parseEnvBoolean("1", false)).toBe(true);
    expect(parseEnvBoolean("YES", false)).toBe(true);
    expect(parseEnvBoolean("on", false)).toBe(true);
  });

  it("parses false-like values", () => {
    expect(parseEnvBoolean("false", true)).toBe(false);
    expect(parseEnvBoolean("0", true)).toBe(false);
    expect(parseEnvBoolean("NO", true)).toBe(false);
    expect(parseEnvBoolean("off", true)).toBe(false);
  });

  it("falls back to default for empty or unknown values", () => {
    expect(parseEnvBoolean(undefined, true)).toBe(true);
    expect(parseEnvBoolean(null, false)).toBe(false);
    expect(parseEnvBoolean("", true)).toBe(true);
    expect(parseEnvBoolean("maybe", false)).toBe(false);
  });
});
