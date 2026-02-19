import { describe, expect, it } from "vitest";
import {
  resolveWorkspace,
  parseWorkspaceMentions,
  stripWorkspaceMentions,
  selectExecutorProfile,
  getLocalWorkspace,
  listWorkspaceIds,
  formatBusMessage,
  formatRegistryDiagnostics,
} from "../workspace-registry.mjs";

const registryFixture = {
  default_workspace: "primary",
  workspaces: [
    {
      id: "primary",
      name: "Primary",
      aliases: ["main"],
      mentions: ["primary", "coord"],
      model_priorities: ["copilot:claude_opus_4_6"],
    },
    {
      id: "staging",
      name: "Staging",
      aliases: ["stage"],
      mentions: ["staging"],
    },
    {
      id: "prod",
      name: "Production",
      aliases: ["production"],
      mentions: ["prod"],
    },
  ],
};

describe("resolveWorkspace", () => {
  it("matches exact workspace id", () => {
    const result = resolveWorkspace(registryFixture, "prod");

    expect(result).not.toBeNull();
    expect(result.id).toBe("prod");
  });

  it("matches aliases", () => {
    const result = resolveWorkspace(registryFixture, "production");

    expect(result).not.toBeNull();
    expect(result.id).toBe("prod");
  });

  it("does not match partial ids", () => {
    const result = resolveWorkspace(registryFixture, "sta");

    expect(result).toBeNull();
  });

  it("returns null when there is no match", () => {
    const result = resolveWorkspace(registryFixture, "unknown");

    expect(result).toBeNull();
  });

  it("is case-insensitive for candidate ids", () => {
    const result = resolveWorkspace(registryFixture, "PROD");

    expect(result).not.toBeNull();
    expect(result.id).toBe("prod");
  });

  it("returns null with an empty registry", () => {
    const result = resolveWorkspace({ workspaces: [] }, "prod");

    expect(result).toBeNull();
  });
});

describe("parseWorkspaceMentions", () => {
  it("finds a single mention", () => {
    const result = parseWorkspaceMentions("deploy to @prod", registryFixture);

    expect(result.broadcast).toBe(false);
    expect(Array.from(result.targets)).toEqual(["prod"]);
  });

  it("finds multiple mentions", () => {
    const result = parseWorkspaceMentions(
      "@staging and @prod",
      registryFixture,
    );

    expect(result.broadcast).toBe(false);
    expect(Array.from(result.targets).sort()).toEqual(["prod", "staging"]);
  });

  it("returns empty set when no mentions exist", () => {
    const result = parseWorkspaceMentions("deploy now", registryFixture);

    expect(result.broadcast).toBe(false);
    expect(Array.from(result.targets)).toEqual([]);
  });

  it("ignores mentions not in registry", () => {
    const result = parseWorkspaceMentions(
      "ship to @unknown",
      registryFixture,
    );

    expect(result.broadcast).toBe(false);
    expect(Array.from(result.targets)).toEqual([]);
  });

  it("handles mentions at start and end of a line", () => {
    const start = parseWorkspaceMentions("@prod release", registryFixture);
    const end = parseWorkspaceMentions("deploy @staging", registryFixture);

    expect(Array.from(start.targets)).toEqual(["prod"]);
    expect(Array.from(end.targets)).toEqual(["staging"]);
  });
});

describe("stripWorkspaceMentions", () => {
  it("removes mentions and cleans up whitespace", () => {
    const text = "deploy  @prod  now [ws:staging]";

    const result = stripWorkspaceMentions(text, registryFixture);

    expect(result).toBe("deploy now");
  });

  it("returns the original text when no mentions exist", () => {
    const text = "deploy now";

    const result = stripWorkspaceMentions(text, registryFixture);

    expect(result).toBe(text);
  });
});

describe("selectExecutorProfile", () => {
  it("prefers override profile", () => {
    const workspace = registryFixture.workspaces[0];

    const result = selectExecutorProfile(workspace, "codex:high");

    expect(result).toEqual({ executor: "CODEX", variant: "HIGH" });
  });

  it("uses workspace default when no override is supplied", () => {
    const workspace = registryFixture.workspaces[0];

    const result = selectExecutorProfile(workspace);

    expect(result).toEqual({
      executor: "COPILOT",
      variant: "CLAUDE_OPUS_4_6",
    });
  });

  it("falls back to default when executor config is missing", () => {
    const workspace = { id: "fallback" };

    const result = selectExecutorProfile(workspace);

    expect(result).toEqual({ executor: "CODEX", variant: "DEFAULT" });
  });
});

describe("getLocalWorkspace", () => {
  it("resolves to the matching env workspace id", () => {
    const result = getLocalWorkspace(registryFixture, "staging");

    expect(result).not.toBeNull();
    expect(result.id).toBe("staging");
  });

  it("falls back when env workspace id does not match", () => {
    const result = getLocalWorkspace(registryFixture, "unknown");

    expect(result).not.toBeNull();
    expect(result.id).toBe("primary");
  });
});

describe("listWorkspaceIds", () => {
  it("returns ids from the registry", () => {
    const result = listWorkspaceIds(registryFixture);

    expect(result).toEqual(["primary", "staging", "prod"]);
  });

  it("returns empty array for empty registry", () => {
    const result = listWorkspaceIds({ workspaces: [] });

    expect(result).toEqual([]);
  });
});

describe("formatBusMessage", () => {
  it("formats the standard bus message", () => {
    const result = formatBusMessage({
      workspaceId: "prod",
      type: "alert",
      text: "deploy now",
    });

    expect(result).toBe("[ws:prod][alert] deploy now");
  });
});

describe("formatRegistryDiagnostics", () => {
  it("formats errors only", () => {
    const result = formatRegistryDiagnostics(["bad registry"], []);

    expect(result).toBe("❌ Registry errors:\n  • bad registry");
  });

  it("formats warnings only", () => {
    const result = formatRegistryDiagnostics([], ["missing file"]);

    expect(result).toBe("⚠️ missing file");
  });

  it("formats errors and warnings together", () => {
    const result = formatRegistryDiagnostics(
      ["bad registry"],
      ["missing file", "defaults applied"],
    );

    expect(result).toBe(
      "❌ Registry errors:\n  • bad registry\n⚠️ missing file\n⚠️ defaults applied",
    );
  });

  it("returns null when there are no diagnostics", () => {
    const result = formatRegistryDiagnostics([], []);

    expect(result).toBeNull();
  });
});