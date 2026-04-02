import { describe, expect, it } from "vitest";

import { normalizeProviderAuthState } from "../agent/provider-auth-manager.mjs";
import { getProviderModelCatalog } from "../agent/provider-model-catalog.mjs";

describe("provider auth and model settings", () => {
  it("uses provider settings to enable advanced providers and surface configured auth mode", () => {
    const auth = normalizeProviderAuthState("openai-compatible", {}, {
      env: {
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4000/v1",
      },
      settings: {
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODE: "local",
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL: "qwen2.5-coder:latest",
      },
    });

    expect(auth.enabled).toBe(true);
    expect(auth.status).toBe("local_ready");
    expect(auth.preferredMode).toBe("local");
    expect(auth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "local",
      defaultModel: "qwen2.5-coder:latest",
    }));
  });

  it("surfaces subscription workspace settings through auth normalization", () => {
    const chatgptAuth = normalizeProviderAuthState("openai-codex-subscription", {}, {
      settings: {
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE: "chatgpt-team-alpha",
      },
    });
    const claudeAuth = normalizeProviderAuthState("claude-subscription-shim", {}, {
      settings: {
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE: "claude-lab-beta",
      },
    });

    expect(chatgptAuth.enabled).toBe(true);
    expect(chatgptAuth.settings).toEqual(expect.objectContaining({
      workspace: "chatgpt-team-alpha",
    }));
    expect(claudeAuth.enabled).toBe(true);
    expect(claudeAuth.settings).toEqual(expect.objectContaining({
      workspace: "claude-lab-beta",
    }));
  });

  it("prefers provider-scoped model settings over built-in defaults", () => {
    const catalog = getProviderModelCatalog("azure-openai-responses", {
      settings: {
        BOSUN_PROVIDER_AZURE_OPENAI_ENABLED: "true",
        BOSUN_PROVIDER_AZURE_OPENAI_MODEL: "o4-mini",
      },
    });

    expect(catalog.enabled).toBe(true);
    expect(catalog.defaultModel).toBe("o4-mini");
    expect(catalog.models.some((entry) => entry.id === "o4-mini" && entry.default === true)).toBe(true);
  });
});
