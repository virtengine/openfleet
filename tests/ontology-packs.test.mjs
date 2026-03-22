import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildLocalOntologyPromptBlock,
  formatCapabilityOntologyPacks,
  loadLocalCapabilityOntologyPacks,
} from "../agent/ontology-packs.mjs";

describe("ontology packs", () => {
  it("formats typed workflow, MCP, and schema bundles", () => {
    const block = formatCapabilityOntologyPacks([
      {
        id: "slack-ops",
        version: "1.2.0",
        workflowNodes: [{ type: "action.mcp_tool_call", inputs: [{ name: "tool", type: "string", required: true }] }, { name: "action.json_transform" }],
        mcpTools: [{ server: "slack", name: "post_message", inputSchema: { required: ["channel", "text"] }, inputs: [{ name: "thread_ts", type: "string" }] }],
        integrationSchemas: [{ name: "slack.message", fields: [{ name: "channel", type: "string", required: true }, { name: "text", type: "string", required: true }, { name: "thread_ts", type: "string" }] }],
      },
    ]);

    expect(block).toContain("## Capability Ontology Packs");
    expect(block).toContain("**slack-ops** (capability-pack@1.2.0)");
    expect(block).toContain("Workflow nodes: action.mcp_tool_call inputs=tool:string required, action.json_transform");
    expect(block).toContain("MCP tools: slack/post_message required=channel,text inputs=thread_ts:string");
    expect(block).toContain("Integration schemas: slack.message fields=channel:string required,text:string required,thread_ts:string");
  });

  it("loads local ontology pack files from .bosun/ontology-packs", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "bosun-ontology-"));
    try {
      const packsDir = resolve(rootDir, ".bosun", "ontology-packs");
      mkdirSync(packsDir, { recursive: true });
      writeFileSync(resolve(packsDir, "github.json"), JSON.stringify({
        id: "github-pr",
        kind: "ontology-pack",
        installHint: "npm i @acme/github-pack",
        workflowNodes: [{ type: "action.mcp_pipeline" }],
        mcpTools: [{ server: "github", tool: "create_pull_request", inputs: [{ name: "title", type: "string", required: true }] }],
        integrationSchemas: [{ id: "github.pull_request", fields: [{ name: "title", type: "string", required: true }, { name: "body", type: "string" }] }],
      }, null, 2));

      const packs = loadLocalCapabilityOntologyPacks(rootDir);
      expect(packs).toHaveLength(1);
      expect(packs[0]).toEqual(expect.objectContaining({
        id: "github-pr",
        kind: "ontology-pack",
        installHint: "npm i @acme/github-pack",
        nodes: ["action.mcp_pipeline"],
        tools: ["github/create_pull_request inputs=title:string required"],
        schemas: ["github.pull_request fields=title:string required,body:string"],
      }));

      const block = buildLocalOntologyPromptBlock(rootDir);
      expect(block).toContain("## Local Ontology Packs");
      expect(block).toContain("**github-pr** (ontology-pack)");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
