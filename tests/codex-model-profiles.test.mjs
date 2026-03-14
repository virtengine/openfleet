import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn();
const readFileSync = vi.fn();
const homedir = vi.fn(() => "/mock-home");

vi.mock("node:fs", () => ({
  existsSync: (...args) => existsSync(...args),
  readFileSync: (...args) => readFileSync(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => homedir(),
}));

const { resolveCodexProfileRuntime } = await import("../shell/codex-model-profiles.mjs");

describe("codex-model-profiles", () => {
  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    homedir.mockClear();
    existsSync.mockReturnValue(false);
  });

  it("resolves env-safe prefixes for hyphenated profile names", () => {
    const result = resolveCodexProfileRuntime({
      CODEX_MODEL_PROFILE: "codex-azure-sweden",
      CODEX_MODEL_PROFILE_CODEX_AZURE_SWEDEN_PROVIDER: "azure",
      CODEX_MODEL_PROFILE_CODEX_AZURE_SWEDEN_MODEL: "gpt-5.4",
      CODEX_MODEL_PROFILE_CODEX_AZURE_SWEDEN_BASE_URL:
        "https://sweden-central-openloans-resourc.openai.azure.com/openai/v1",
      CODEX_MODEL_PROFILE_CODEX_AZURE_SWEDEN_API_KEY: "sweden-key",
    });

    expect(result.activeProfile).toBe("codex-azure-sweden");
    expect(result.provider).toBe("azure");
    expect(result.active.model).toBe("gpt-5.4");
    expect(result.active.baseUrl).toBe(
      "https://sweden-central-openloans-resourc.openai.azure.com/openai/v1",
    );
    expect(result.env.OPENAI_BASE_URL).toBe(
      "https://sweden-central-openloans-resourc.openai.azure.com/openai/v1",
    );
    expect(result.env.AZURE_OPENAI_API_KEY).toBe("sweden-key");
    expect(result.env.OPENAI_API_KEY).toBe("sweden-key");
  });

  it("keeps the literal profile name while reading the exact prefix first", () => {
    const result = resolveCodexProfileRuntime({
      CODEX_MODEL_PROFILE: "codex-azure-sweden",
      "CODEX_MODEL_PROFILE_CODEX-AZURE-SWEDEN_MODEL": "gpt-5.3-codex",
      CODEX_MODEL_PROFILE_CODEX_AZURE_SWEDEN_MODEL: "gpt-5.4",
    });

    expect(result.activeProfile).toBe("codex-azure-sweden");
    expect(result.active.model).toBe("gpt-5.3-codex");
    expect(result.env.CODEX_MODEL).toBe("gpt-5.3-codex");
  });
});