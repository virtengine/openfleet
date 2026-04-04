import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { normalizeProviderAuthState } from "../agent/provider-auth-manager.mjs";
import { getProviderModelCatalog } from "../agent/provider-model-catalog.mjs";

describe("provider auth and model settings", () => {
  it("uses provider settings to enable advanced providers and surface configured auth mode", () => {
    const auth = normalizeProviderAuthState("openai-compatible", {}, {
      implicitAuth: false,
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
      implicitAuth: false,
      settings: {
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE: "chatgpt-team-alpha",
      },
    });
    const claudeAuth = normalizeProviderAuthState("claude-subscription-shim", {}, {
      implicitAuth: false,
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

  it("surfaces Claude OAuth warning metadata when subscription auth is enabled", () => {
    const claudeAuth = normalizeProviderAuthState("claude-subscription-shim", {
      connected: true,
      authenticated: true,
      sessionActive: true,
    }, {
      implicitAuth: false,
      settings: {
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE: "oauth",
      },
    });

    expect(claudeAuth.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "claude_oauth_tos_warning",
          severity: "warning",
        }),
      ]),
    );
  });

  it("detects Codex auth.json during auth normalization and surfaces the source path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-codex-auth-"));
    const authPath = join(tempDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        access_token: "header.payload.signature",
        account_id: "acct_123",
      },
    }));

    const codexAuth = normalizeProviderAuthState("openai-codex-subscription", {}, {
      env: {
        CODEX_AUTH_JSON_PATH: authPath,
      },
      settings: {
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
      },
    });

    expect(codexAuth.authenticated).toBe(true);
    expect(codexAuth.preferredMode).toBe("oauth");
    expect(codexAuth.connection).toEqual(expect.objectContaining({
      authSource: "auth.json",
      accountId: "acct_123",
      authPath,
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
