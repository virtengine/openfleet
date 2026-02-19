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
      "collab = false",
      "shell_tool = false",
      "unified_exec = false",
      "undo = false",
      "",
    ].join("\n");

    const { toml } = ensureFeatureFlags(input);

    expect(toml).toContain("child_agents_md = true");
    expect(toml).toContain("memory_tool = true");
    expect(toml).toContain("collab = true");
    expect(toml).toContain("shell_tool = true");
    expect(toml).toContain("unified_exec = true");
    expect(toml).toContain("undo = false");
  });

  it("adds agents.max_threads when missing", () => {
    const input = ["[features]", "child_agents_md = true", ""].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(true);
    expect(result.toml).toContain("[agents]");
    expect(result.toml).toContain("max_threads = 12");
  });

  it("overwrites agents.max_threads when explicitly requested", () => {
    const input = ["[agents]", "max_threads = 4", "", "[features]"].join("\n");
    const result = ensureAgentMaxThreads(input, {
      maxThreads: 12,
      overwrite: true,
    });
    expect(result.changed).toBe(true);
    expect(result.toml).toContain("max_threads = 12");
  });

  it("does not overwrite agents.max_threads by default", () => {
    const input = ["[agents]", "max_threads = 4", ""].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(false);
    expect(result.toml).toContain("max_threads = 4");
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
