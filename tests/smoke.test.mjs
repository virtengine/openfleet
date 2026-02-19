import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.mjs";

describe("bosun smoke", () => {
  it("imports ESM modules", () => {
    expect(typeof loadConfig).toBe("function");
  });
});
