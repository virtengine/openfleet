import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("telegram async safety", () => {
  const botSource = readFileSync(resolve(process.cwd(), "telegram-bot.mjs"), "utf8");

  it("adds a tagged safeDetach helper", () => {
    expect(botSource).toContain("function safeDetach");
    expect(botSource).toContain("SAFE_DETACH_PREFIX");
    expect(botSource).toContain("async-detach");
  });

  it("guards detached command handlers", () => {
    expect(botSource).toContain('safeDetach("free-text", () => handleFreeText');
    expect(botSource).toContain(
      'safeDetach("background-free-text", () => handleFreeText',
    );
    expect(botSource).toContain(
      'safeDetach("manual-start", () => executor.executeTask',
    );
  });

  it("guards menu refresh and presence timers", () => {
    expect(botSource).toContain(
      'safeDetach("menu-button-refresh", refreshMenuButton)',
    );
    expect(botSource).toContain(
      'setInterval(() => safeDetach("menu-button-refresh", refreshMenuButton)',
    );
    expect(botSource).toContain('safeDetach("presence-heartbeat", sendPresence)');
  });

  it("guards poll lock release on shutdown", () => {
    expect(botSource).toContain(
      'safeDetach("poll-lock-release", releaseTelegramPollLock)',
    );
  });

  it("removes bare void async invocations", () => {
    expect(botSource).not.toMatch(/\bvoid\s+handleFreeText/);
    expect(botSource).not.toMatch(/\bvoid\s+refreshMenuButton/);
    expect(botSource).not.toMatch(/\bvoid\s+sendPresence/);
    expect(botSource).not.toMatch(/\bvoid\s+releaseTelegramPollLock/);
    expect(botSource).not.toMatch(/\bvoid\s+executor\.executeTask/);
    expect(botSource).not.toMatch(/\bvoid\s+doEdit/);
  });
});
