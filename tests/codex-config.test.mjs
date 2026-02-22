import { describe, expect, it } from "vitest";
import {
  buildCommonMcpBlocks,
  ensureAgentMaxThreads,
  ensureFeatureFlags,
  ensureSandboxWorkspaceWrite,
} from "../codex-config.mjs";

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
      "memory_tool = false",
      "multi_agent = false",
      "shell_tool = false",
      "unified_exec = false",
      "undo = false",
      "",
    ].join("\n");

    const { toml } = ensureFeatureFlags(input);

    expect(toml).toContain("child_agents_md = true");
    expect(toml).toContain("memory_tool = true");
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
    expect(result.toml).toContain('"/tmp/virtengine/.git"');
  });
});
