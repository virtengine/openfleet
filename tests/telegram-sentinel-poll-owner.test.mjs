import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("telegram-sentinel poll owner arbitration", () => {
  const source = readFileSync(resolve(process.cwd(), "telegram-sentinel.mjs"), "utf8");

  it("claims owner before starting standalone polling", () => {
    expect(source).toContain('claimTelegramPollOwner("telegram-sentinel"');
    expect(source).toContain("canStartSentinelPolling");
  });

  it("releases owner on companion transition and stop", () => {
    expect(source).toContain("releaseTelegramPollOwner(\"telegram-sentinel\")");
  });

  it("stands down on Telegram getUpdates conflict", () => {
    expect(source).toContain("TELEGRAM_POLL_CONFLICT");
    expect(source).toContain("polling = false");
  });

  it("reads monitor pid from repo cache with legacy fallbacks", () => {
    expect(source).toContain('const MONITOR_PID_FILE = resolve(cacheDir, "bosun.pid");');
    expect(source).toContain("function readMonitorPid()");
    expect(source).toContain("MONITOR_PID_FILE_LEGACY");
  });
});
