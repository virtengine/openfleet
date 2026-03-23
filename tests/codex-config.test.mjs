import { describe, expect, it } from "vitest";
import {
  buildCommonMcpBlocks,
  buildSandboxPermissions,
  ensureAgentMaxThreads,
  ensureFeatureFlags,
  ensureModelProviderSectionsFromEnv,
  ensureSandboxWorkspaceWrite,
  ensureTrustedProjects,
  ensureTopLevelSandboxPermissions,
} from "../shell/codex-config.mjs";
import { resolveCodexProfileRuntime } from "../shell/codex-model-profiles.mjs";

describe("codex-config defaults", () => {
  it("includes expanded MCP server defaults", () => {
    const block = buildCommonMcpBlocks();
    expect(block).toContain("[mcp_servers.context7]");
    expect(block).toContain("[mcp_servers.sequential-thinking]");
    expect(block).toContain("[mcp_servers.playwright]");
    expect(block).toContain("[mcp_servers.microsoft-docs]");
  });

  it("forces critical features back to true when disabled", () => {
    const input = [
      "[features]",
      "child_agents_md = false",
      "memories = false",
      "multi_agent = false",
      "shell_tool = false",
      "unified_exec = false",
      "undo = false",
      "",
    ].join("\n");

    const { toml } = ensureFeatureFlags(input);

    expect(toml).toContain("child_agents_md = true");
    expect(toml).toContain("memories = true");
    expect(toml).toContain("multi_agent = true");
    expect(toml).toContain("shell_tool = true");
    expect(toml).toContain("unified_exec = true");
    expect(toml).toContain("undo = false");
  });

  it("adds max_threads under [agent_sdk] when section exists but key is missing", () => {
    const input = [
      "[agent_sdk]",
      'primary = "codex"',
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
      "[features]",
      "child_agents_md = true",
      "",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(true);
    expect(result.added).toBe(true);
    // max_threads should be under [agent_sdk], NOT [agents]
    const agentSdkIdx = result.toml.indexOf("[agent_sdk]");
    const capsIdx = result.toml.indexOf("[agent_sdk.capabilities]");
    const maxThreadsIdx = result.toml.indexOf("max_threads = 12");
    expect(maxThreadsIdx).toBeGreaterThan(agentSdkIdx);
    expect(maxThreadsIdx).toBeLessThan(capsIdx);
  });

  it("overwrites max_threads under [agent_sdk] when explicitly requested", () => {
    const input = [
      "[agent_sdk]",
      'primary = "codex"',
      "max_threads = 4",
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
      "[features]",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, {
      maxThreads: 12,
      overwrite: true,
    });
    expect(result.changed).toBe(true);
    expect(result.toml).toContain("max_threads = 12");
    expect(result.toml).not.toContain("max_threads = 4");
  });

  it("does not overwrite max_threads under [agent_sdk] by default", () => {
    const input = [
      "[agent_sdk]",
      'primary = "codex"',
      "max_threads = 4",
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(false);
    expect(result.toml).toContain("max_threads = 4");
  });

  it("migrates stale max_threads from [agents] to [agent_sdk]", () => {
    const input = [
      "[agents]",
      "# Max concurrent agent threads per Codex session.",
      "max_threads = 8",
      "",
      "[agent_sdk]",
      'primary = "codex"',
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(true);
    // Stale max_threads should be removed from [agents]
    const agentsMatch = result.toml.match(/\[agents\][^[]*max_threads/);
    expect(agentsMatch).toBeNull();
    // max_threads should be added under [agent_sdk]
    expect(result.toml).toContain("max_threads = 12");
  });

  it("honors env overrides for feature flags", () => {
    const input = ["[features]", "use_linux_sandbox_bwrap = true", ""].join("\n");
    const { toml } = ensureFeatureFlags(input, {
      CODEX_FEATURES_BWRAP: "false",
    });
    expect(toml).toContain("use_linux_sandbox_bwrap = false");
  });

  it("adds sandbox workspace-write defaults with repo roots", () => {
    const input = ["[features]", "child_agents_md = true", ""].join("\n");
    const result = ensureSandboxWorkspaceWrite(input, {
      repoRoot: "/tmp/virtengine",
      writableRoots: "",
    });
    expect(result.changed).toBe(true);
    expect(result.added).toBe(true);
    expect(result.toml).toContain("[sandbox_workspace_write]");
    expect(result.toml).toContain('"/tmp"');
    expect(result.toml).toContain('"/tmp/virtengine"');
    // .git is only added when the directory actually exists on disk
    // (normalizeWritableRoots rejects phantom .git paths)
  });
  it("supports legacy sandbox_permissions helper names", () => {
    const line = buildSandboxPermissions("disk-full-write-access");
    expect(line).toContain('sandbox_mode = "workspace-write"');

    const result = ensureTopLevelSandboxPermissions("[features]\nchild_agents_md = true\n", "disk-full-write-access");
    expect(result.changed).toBe(true);
    expect(result.toml).toContain('sandbox_mode = "workspace-write"');
  });

  it("adds Windows namespace trusted path variants for WSL-style paths", () => {
    const uniquePath = `/mnt/c/Users/jON/Documents/source/repos/virtengine-gh/bosun/.tmp-trust-${Date.now()}`;
    const result = ensureTrustedProjects([uniquePath], { dryRun: true });
    const allEntries = [...result.added, ...result.already];
    expect(allEntries.some((entry) => entry.includes("\\\\?\\C:\\"))).toBe(true);
  });

  it("normalizes Azure OpenAI runtime base URLs for Codex", () => {
    const result = resolveCodexProfileRuntime({
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21",
      OPENAI_API_KEY: "azure-key",
      CODEX_MODEL: "gpt-5-deployment",
    });

    expect(result.provider).toBe("azure");
    expect(result.env.OPENAI_BASE_URL).toBe("https://example-resource.openai.azure.com/openai/v1");
    expect(result.active.baseUrl).toBe("https://example-resource.openai.azure.com/openai/v1");
  });

  it("rewrites stale Azure provider base_url entries to the normalized models-safe endpoint", () => {
    const input = [
      "[model_providers.azure]",
      'name = "Azure OpenAI"',
      'base_url = "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21"',
      'env_key = "AZURE_OPENAI_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n");

    const result = ensureModelProviderSectionsFromEnv(input, {
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21",
      OPENAI_API_KEY: "azure-key",
      CODEX_MODEL: "gpt-5-deployment",
    });

    expect(result.added).toEqual([]);
    expect(result.updated).toContain("azure.base_url");
    expect(result.toml).toContain('base_url = "https://example-resource.openai.azure.com/openai/v1"');
    expect(result.toml).not.toContain('/openai/deployments/gpt-5/chat/completions');
  });
});


