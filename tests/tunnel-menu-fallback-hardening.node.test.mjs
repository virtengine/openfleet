import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const uiServerSource = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
const telegramBotSource = readFileSync(resolve(process.cwd(), "telegram-bot.mjs"), "utf8");

describe("ui-server tunnel fallback hardening", () => {
  it("defaults tunnel mode to named and supports explicit quick fallback opt-in", () => {
    assert.ok(
      uiServerSource.includes("const DEFAULT_TUNNEL_MODE = TUNNEL_MODE_NAMED"),
      "named tunnel should be the default mode",
    );
    assert.ok(
      uiServerSource.includes("TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK"),
      "quick fallback flag should be configurable",
    );
  });

  it("gates quick fallback behind explicit allowQuickFallback", () => {
    const hasExplicitGate =
      uiServerSource.includes("if (tunnelCfg.allowQuickFallback)") &&
      uiServerSource.includes(
        "named tunnel failed; falling back to quick tunnel (explicitly allowed)",
      );
    assert.ok(
      hasExplicitGate,
      "quick fallback must only run when explicitly enabled",
    );
  });
});

describe("telegram-bot tunnel URL propagation", () => {
  it("prioritizes tunnel URL for mini-app launch URLs", () => {
    assert.ok(
      telegramBotSource.includes("const candidates = [tUrl, explicit, url]"),
      "mini-app URL selection should prioritize the tunnel URL",
    );
    assert.ok(
      telegramBotSource.includes("const currentUiUrl = getTunnelUrl() || getTelegramUiUrl?.() || null"),
      "URL sync should prefer tunnel URL before LAN/local URL",
    );
  });

  it("refreshes Telegram menu button when the tunnel URL changes", () => {
    const hasReactiveRefresh =
      telegramBotSource.includes("onTunnelUrlChange((url) => {") &&
      telegramBotSource.includes("safeDetach(\"menu-button-refresh\", refreshMenuButton)");
    assert.ok(
      hasReactiveRefresh,
      "menu button should be refreshed immediately when hostname changes",
    );
  });
});
