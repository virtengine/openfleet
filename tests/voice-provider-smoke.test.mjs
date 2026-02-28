import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_TUNNEL",
  "TELEGRAM_UI_PORT",
  "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
  "BOSUN_UI_AUTO_OPEN_BROWSER",
  "BOSUN_ENV_NO_OVERRIDE",
  "VOICE_ENABLED",
  "VOICE_PROVIDER",
  "VOICE_MODEL",
  "VOICE_VISION_MODEL",
  "VOICE_FALLBACK_MODE",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_REALTIME_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_REALTIME_ENDPOINT",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

const PROVIDER_MATRIX = Object.freeze([
  {
    id: "openai",
    env: {
      VOICE_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test-openai",
      VOICE_MODEL: "gpt-4o-realtime-preview-2024-12-17",
      VOICE_VISION_MODEL: "gpt-4.1-mini",
    },
    expectTier: 1,
    expectTokenStatus: 200,
    expectVisionProvider: "openai",
    expectedOutbound: {
      token: "api.openai.com/v1/realtime/sessions",
      vision: "api.openai.com/v1/responses",
    },
    visionReply: "OpenAI vision smoke summary.",
  },
  {
    id: "claude",
    env: {
      VOICE_PROVIDER: "claude",
      ANTHROPIC_API_KEY: "sk-ant-test",
      VOICE_MODEL: "claude-3-7-sonnet-latest",
      VOICE_VISION_MODEL: "claude-3-7-sonnet-latest",
    },
    expectTier: 2,
    expectTokenStatus: 500,
    expectVisionProvider: "claude",
    expectedOutbound: {
      vision: "api.anthropic.com/v1/messages",
    },
    visionReply: "Claude vision smoke summary.",
  },
  {
    id: "gemini",
    env: {
      VOICE_PROVIDER: "gemini",
      GEMINI_API_KEY: "gemini-test-key",
      VOICE_MODEL: "gemini-2.5-pro",
      VOICE_VISION_MODEL: "gemini-2.5-flash",
    },
    expectTier: 2,
    expectTokenStatus: 500,
    expectVisionProvider: "gemini",
    expectedOutbound: {
      vision: "generativelanguage.googleapis.com/v1beta/models/",
    },
    visionReply: "Gemini vision smoke summary.",
  },
]);

const _realFetch = globalThis.fetch;
let envSnapshot = {};
let uiServerModule = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function outboundFetchMockForScenario(scenario) {
  const outboundUrls = [];
  globalThis.fetch = vi.fn(async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (url.startsWith("http://127.0.0.1:")) {
      return _realFetch(input, init);
    }

    outboundUrls.push(url);

    if (scenario.id === "openai") {
      if (url.includes("/v1/realtime/sessions")) {
        return jsonResponse({
          client_secret: {
            value: "openai-smoke-token",
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
        });
      }
      if (url.includes("/v1/responses")) {
        return jsonResponse({ output_text: scenario.visionReply });
      }
    }

    if (scenario.id === "claude" && url.includes("api.anthropic.com/v1/messages")) {
      return jsonResponse({
        content: [{ type: "text", text: scenario.visionReply }],
      });
    }

    if (
      scenario.id === "gemini" &&
      url.includes("generativelanguage.googleapis.com/v1beta/models/") &&
      url.includes(":generateContent")
    ) {
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: scenario.visionReply }],
            },
          },
        ],
      });
    }

    return jsonResponse({ error: `unexpected outbound request: ${url}` }, 500);
  });
  return outboundUrls;
}

async function startServer() {
  uiServerModule = await import("../ui-server.mjs");
  const server = await uiServerModule.startTelegramUiServer({
    host: "127.0.0.1",
    port: 0,
    skipInstanceLock: true,
    skipAutoOpen: true,
  });
  const port = Number(server.address()?.port || 0);
  return { server, port };
}

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  process.env.TELEGRAM_UI_TLS_DISABLE = "true";
  process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
  process.env.TELEGRAM_UI_TUNNEL = "disabled";
  process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
  process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "0";
  process.env.BOSUN_ENV_NO_OVERRIDE = "1";
  process.env.VOICE_ENABLED = "true";
  process.env.VOICE_FALLBACK_MODE = "browser";

  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_REALTIME_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_REALTIME_API_KEY;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_REALTIME_ENDPOINT;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  globalThis.fetch = _realFetch;
});

afterEach(async () => {
  if (uiServerModule?.stopTelegramUiServer) {
    uiServerModule.stopTelegramUiServer();
  }
  uiServerModule = null;
  globalThis.fetch = _realFetch;

  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe("voice provider smoke matrix", () => {
  for (const scenario of PROVIDER_MATRIX) {
    it(`validates config/token/vision routes for ${scenario.id}`, async () => {
      Object.entries(scenario.env || {}).forEach(([key, value]) => {
        process.env[key] = value;
      });

      const outboundUrls = outboundFetchMockForScenario(scenario);
      const { port } = await startServer();
      const voiceRelay = await import("../voice-relay.mjs");
      voiceRelay.getVoiceConfig(true);

      const configRes = await _realFetch(`http://127.0.0.1:${port}/api/voice/config`);
      expect(configRes.status).toBe(200);
      const configJson = await configRes.json();
      expect(configJson.available).toBe(true);
      expect(configJson.provider).toBe(scenario.id);
      expect(configJson.tier).toBe(scenario.expectTier);

      const tokenRes = await _realFetch(`http://127.0.0.1:${port}/api/voice/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: `smoke-${scenario.id}-${Date.now()}`,
          executor: scenario.id === "openai" ? "codex-sdk" : "gemini-sdk",
          mode: "agent",
          model: scenario.env.VOICE_MODEL,
        }),
      });
      expect(tokenRes.status).toBe(scenario.expectTokenStatus);
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (scenario.expectTokenStatus === 200) {
        expect(tokenJson.provider).toBe(scenario.id);
        expect(String(tokenJson.token || "")).not.toBe("");
      } else {
        expect(String(tokenJson.error || "")).toMatch(
          new RegExp(`provider \"${scenario.id}\"`, "i"),
        );
      }

      const visionRes = await _realFetch(`http://127.0.0.1:${port}/api/vision/frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: `smoke-vision-${scenario.id}-${Date.now()}`,
          source: "screen",
          frameDataUrl: "data:image/jpeg;base64,dGVzdA==",
          width: 1280,
          height: 720,
        }),
      });
      expect(visionRes.status).toBe(200);
      const visionJson = await visionRes.json();
      expect(visionJson.ok).toBe(true);
      expect(visionJson.analyzed).toBe(true);
      expect(visionJson.provider).toBe(scenario.expectVisionProvider);
      expect(String(visionJson.summary || "")).toMatch(/smoke summary/i);

      if (scenario.expectedOutbound?.token) {
        expect(outboundUrls.some((url) => url.includes(scenario.expectedOutbound.token))).toBe(
          true,
        );
      }
      if (scenario.expectedOutbound?.vision) {
        expect(outboundUrls.some((url) => url.includes(scenario.expectedOutbound.vision))).toBe(
          true,
        );
      }
    });
  }
});
