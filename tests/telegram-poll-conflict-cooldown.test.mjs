import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const telegramBotPath = path.resolve(__dirname, "..", "telegram-bot.mjs");
const source = readFileSync(telegramBotPath, "utf8");

describe("telegram poll conflict guard", () => {
  it("keeps lock-conflict guard message and safe release path", () => {
    expect(source).toContain("async function acquireTelegramPollLock(owner)");
    expect(source).toContain(
      "polling disabled (another getUpdates poller is active)",
    );
    expect(source).toContain("async function releaseTelegramPollLock()");
    expect(source).toContain(
      'detachTelegramTask("poll-lock:release", releaseTelegramPollLock);',
    );
  });

  it("preserves fetch failure cooldown guard used by polling", () => {
    expect(source).toContain("const TELEGRAM_FETCH_FAILURE_COOLDOWN_MS =");
    expect(source).toContain("telegramFetchFailureCooldownUntil");
  });
});
