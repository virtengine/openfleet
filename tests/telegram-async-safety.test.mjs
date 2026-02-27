import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const telegramBotPath = path.resolve(__dirname, "..", "telegram-bot.mjs");
const source = readFileSync(telegramBotPath, "utf8");

describe("telegram-bot async safety", () => {
  it("defines a scoped detach wrapper with consistent tag prefix", () => {
    expect(source).toContain(
      'const TELEGRAM_ASYNC_SAFE_PREFIX = "[telegram-bot] async safety"',
    );
    expect(source).toContain("function detachTelegramTask(tag, taskOrFactory)");
    expect(source).toContain("logDetachedTelegramFailure(tag, err)");
  });

  it("routes key detached handlers through async-safe wrapper", () => {
    expect(source).toContain(
      'detachTelegramTask("free-text:primary-busy", () =>',
    );
    expect(source).toContain(
      'detachTelegramTask("free-text:background-command", () =>',
    );
    expect(source).toContain(
      'detachTelegramTask("menu-button:interval", refreshMenuButton);',
    );
    expect(source).toContain(
      'detachTelegramTask("presence:interval", sendPresence);',
    );
    expect(source).toContain(
      'detachTelegramTask("poll-lock:release", releaseTelegramPollLock);',
    );
  });

  it("uses async-safe wrapper for timer-driven digest and sticky-menu work", () => {
    expect(source).toContain(
      'detachTelegramTask("sticky-menu:bump", () => bumpStickyMenu(chatId));',
    );
    expect(source).toContain(
      'detachTelegramTask("live-digest:seal-window", sealLiveDigest);',
    );
    expect(source).toContain(
      'detachTelegramTask("live-digest:seal-restore", sealLiveDigest);',
    );
    expect(source).toContain(
      'detachTelegramTask("live-digest:seal-edit", () =>',
    );
  });
});
