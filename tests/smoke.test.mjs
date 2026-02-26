import { describe, expect, it } from "vitest";
import { loadConfig } from "../scripts/bosun/config/config.mjs""47;

describe("bosun smoke", () => {
  it("imports ESM modules", () => {
    expect(typeof loadConfig).toBe("function");
  });
});
