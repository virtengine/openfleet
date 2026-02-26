import { describe, expect, it } from "vitest";
import {
  applyTelegramMiniAppSetupEnv,
  normalizeTelegramUiPort,
} from "../setup-web-server.mjs";

describe("setup web server telegram defaults", () => {
  it("normalizes UI port values with a safe fallback", () => {
    expect(normalizeTelegramUiPort("4400")).toBe("4400");
    expect(normalizeTelegramUiPort("0")).toBe("3080");
    expect(normalizeTelegramUiPort("bad-port")).toBe("3080");
  });

  it("injects Mini App defaults when Telegram token is provided", () => {
    const envMap = {};
    const applied = applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
      },
      {},
    );

    expect(applied).toBe(true);
    expect(envMap.TELEGRAM_BOT_TOKEN).toBe("123456:abc-token");
    expect(envMap.TELEGRAM_MINIAPP_ENABLED).toBe("true");
    expect(envMap.TELEGRAM_UI_PORT).toBe("3080");
    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("auto");
    expect(envMap.TELEGRAM_UI_ALLOW_UNSAFE).toBe("false");
  });

  it("respects explicit Mini App settings from setup input", () => {
    const envMap = {};
    applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
        telegramMiniappEnabled: false,
        telegramUiPort: 4522,
        telegramUiTunnel: "cloudflared",
        telegramUiAllowUnsafe: true,
      },
      {},
    );

    expect(envMap.TELEGRAM_MINIAPP_ENABLED).toBe("false");
    expect(envMap.TELEGRAM_UI_PORT).toBe("4522");
    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("cloudflared");
    expect(envMap.TELEGRAM_UI_ALLOW_UNSAFE).toBe("true");
  });

  it("does not mutate env map when Telegram is not configured", () => {
    const envMap = {};
    const applied = applyTelegramMiniAppSetupEnv(envMap, {}, {});

    expect(applied).toBe(false);
    expect(envMap).toEqual({});
  });
});
