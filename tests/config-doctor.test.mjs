import { describe, it, expect } from "vitest";
import {
  runConfigDoctor,
  formatConfigDoctorReport,
} from "../config-doctor.mjs";

describe("config-doctor", () => {
  it("returns structured result", () => {
    const result = runConfigDoctor();
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.infos)).toBe(true);
    expect(result.details).toBeDefined();
  });

  it("formats report text", () => {
    const result = runConfigDoctor();
    const output = formatConfigDoctorReport(result);
    expect(typeof output).toBe("string");
    expect(output).toContain("openfleet config doctor");
    expect(output).toContain("Status:");
  });

  it("detects telegram partial config mismatch", () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalChatId = process.env.TELEGRAM_CHAT_ID;
    try {
      process.env.TELEGRAM_BOT_TOKEN = "123:abc";
      process.env.TELEGRAM_CHAT_ID = "";
      const result = runConfigDoctor();
      const hasMismatch = result.errors.some(
        (issue) => issue.code === "TELEGRAM_PARTIAL",
      );
      expect(hasMismatch).toBe(true);
    } finally {
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;

      if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = originalChatId;
    }
  });
});
