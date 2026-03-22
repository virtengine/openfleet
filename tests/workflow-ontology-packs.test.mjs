import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureWorkflowNodeTypesLoaded,
  listNodeTypes,
  stopCustomNodeDiscovery,
} from "../workflow/workflow-nodes.mjs";
import {
  ensureWorkflowOntologyPacksLoaded,
  findWorkflowOntologyCapabilities,
  getInstalledWorkflowOntologyPacks,
  getWorkflowOntologyPackDir,
} from "../workflow/workflow-ontology-packs.mjs";

let repoRoot;

function makeRepoRoot() {
  repoRoot = mkdtempSync(join(tmpdir(), "bosun-ontology-pack-test-"));
  mkdirSync(join(repoRoot, ".bosun", "ontology-packs"), { recursive: true });
  return repoRoot;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  stopCustomNodeDiscovery();
  if (repoRoot) {
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { }
  }
  repoRoot = null;
});

describe("workflow ontology packs", () => {
  it("loads ontology-backed workflow node packs and exposes typed metadata", async () => {
    const root = makeRepoRoot();
    const packDir = join(root, ".bosun", "ontology-packs", "github-ops");
    mkdirSync(packDir, { recursive: true });

    writeJson(join(packDir, "pack.json"), {
      id: "github-ops",
      version: "1.0.0",
      name: "GitHub Ops",
      description: "Capability bundle for GitHub workflows.",
      tags: ["github", "issues"],
      capabilities: ["github", "issue-management"],
      install: {
        strategy: "local",
        packageManager: "bosun",
      },
      ontology: {
        nodes: [
          {
            type: "pack.github.create_issue",
            description: "Create a GitHub issue using a typed pack contract.",
            category: "action",
            inputs: ["default"],
            outputs: ["success", "error"],
            capabilities: ["github"],
            schema: {
              type: "object",
              required: ["repo", "title"],
              properties: {
                repo: { type: "string" },
                title: { type: "string" },
                labels: { type: "array", items: { type: "string" } }
              }
            },
            integration: {
              provider: "github",
              operation: "issues.create"
            },
            mcpTools: [
              {
                server: "github",
                name: "create_issue",
                inputSchema: {
                  type: "object",
                  properties: {
                    repo: { type: "string" },
                    title: { type: "string" }
                  }
                }
              }
            ]
          }
        ],
        integrations: [
          {
            id: "github",
            provider: "github",
            schema: {
              type: "object",
              required: ["owner", "repo"],
              properties: {
                owner: { type: "string" },
                repo: { type: "string" }
              }
            }
          }
        ],
        mcpTools: [
          {
            server: "github",
            name: "list_issues",
            description: "List repository issues",
            inputSchema: {
              type: "object",
              properties: {
                repo: { type: "string" }
              }
            }
          }
        ],
        schemas: [
          {
            id: "github.issue",
            name: "GitHub Issue",
            provider: "github",
            description: "Canonical issue payload for issue workflows.",
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" }
              }
            }
          }
        ]
      }
    });

    await ensureWorkflowOntologyPacksLoaded({ repoRoot: root, forceReload: true });
    await ensureWorkflowNodeTypesLoaded({ repoRoot: root, forceReload: true });

    const pack = getInstalledWorkflowOntologyPacks({ repoRoot: root }).find((entry) => entry.id === "github-ops");
    expect(pack).toBeTruthy();
    expect(pack?.tags).toEqual(["github", "issues"]);
    expect(pack?.capabilities).toEqual(["github", "issue-management"]);
    expect(pack?.install?.strategy).toBe("local");
    expect(pack?.counts).toEqual({ nodes: 1, integrations: 1, mcpTools: 1, schemas: 1 });
    expect(pack?.ontology?.nodes).toHaveLength(1);
    expect(pack?.ontology?.schemas?.[0]?.id).toBe("github.issue");

    const node = listNodeTypes().find((entry) => entry.type === "pack.github.create_issue");
    expect(node).toBeTruthy();
    expect(node?.source).toBe("ontology-pack");
    expect(node?.badge).toBe("pack");
    expect(node?.schema?.required).toEqual(["repo", "title"]);
    expect(node?.ontology?.packId).toBe("github-ops");
    expect(node?.ontology?.capabilities).toEqual(["github"]);
    expect(node?.ontology?.integration?.provider).toBe("github");
    expect(node?.ontology?.mcpTools?.[0]?.name).toBe("create_issue");
  });

  it("finds installable capabilities across nodes, tools, integrations, and schemas", async () => {
    const root = makeRepoRoot();
    const packDir = join(root, ".bosun", "ontology-packs", "slack-ops");
    mkdirSync(packDir, { recursive: true });

    writeJson(join(packDir, "pack.json"), {
      id: "slack-ops",
      name: "Slack Ops",
      capabilities: ["slack", "notifications"],
      ontology: {
        nodes: [
          {
            type: "pack.slack.notify",
            description: "Send a Slack notification",
            category: "action",
            capabilities: ["notifications"],
            integration: { provider: "slack", operation: "chat.postMessage" },
            schema: {
              type: "object",
              properties: {
                channel: { type: "string" },
                text: { type: "string" }
              }
            }
          }
        ],
        mcpTools: [
          {
            server: "slack",
            name: "post_message",
            description: "Post a message to Slack",
            inputSchema: {
              type: "object",
              properties: {
                channel: { type: "string" }
              }
            }
          }
        ],
        integrations: [
          {
            id: "slack",
            provider: "slack",
            description: "Slack workspace integration"
          }
        ],
        schemas: [
          {
            id: "slack.message",
            name: "Slack Message",
            provider: "slack",
            description: "Structured Slack message payload"
          }
        ]
      }
    });

    await ensureWorkflowOntologyPacksLoaded({ repoRoot: root, forceReload: true });

    const slackOnly = findWorkflowOntologyCapabilities({ repoRoot: root, provider: "slack" });
    expect(slackOnly.map((entry) => entry.kind)).toEqual(["node", "mcpTool", "integration", "schema"]);

    const notifications = findWorkflowOntologyCapabilities({ repoRoot: root, capability: "notifications" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("pack.slack.notify");

    const schemaMatch = findWorkflowOntologyCapabilities({ repoRoot: root, query: "message payload" });
    expect(schemaMatch).toHaveLength(1);
    expect(schemaMatch[0]?.kind).toBe("schema");
  });

  it("warns and skips invalid ontology packs", async () => {
    const root = makeRepoRoot();
    const packDir = join(root, ".bosun", "ontology-packs", "broken-pack");
    mkdirSync(packDir, { recursive: true });
    writeJson(join(packDir, "pack.json"), {
      id: "broken-pack",
      ontology: {
        nodes: [
          {
            type: "pack.invalid",
            description: "broken",
            schema: { type: "array" }
          }
        ]
      }
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureWorkflowOntologyPacksLoaded({ repoRoot: root, forceReload: true });

    expect(getInstalledWorkflowOntologyPacks({ repoRoot: root })).toEqual([]);
    expect(listNodeTypes().find((entry) => entry.type === "pack.invalid")).toBeFalsy();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses the repo ontology pack install directory", () => {
    const root = makeRepoRoot();
    const packDir = getWorkflowOntologyPackDir({ repoRoot: root });
    expect(packDir.endsWith(join('.bosun', 'ontology-packs'))).toBe(true);
    expect(existsSync(packDir)).toBe(false);
  });
});
