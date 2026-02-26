import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("telegram poll conflict cooldown", () => {
  const botSource = readFileSync(resolve(process.cwd(), "telegram-bot.mjs"), "utf8");

  it("releases the poll lock on 409 conflicts", () => {
    expect(botSource).toContain("if (res.status === 409)");
    expect(botSource).toContain("releaseTelegramPollLock");
  });

  it("tracks fetch failure cooldown state", () => {
    expect(botSource).toContain("TELEGRAM_FETCH_FAILURE_COOLDOWN_MS");
    expect(botSource).toContain("telegramPreferCurlUntilMs");
  });
});
