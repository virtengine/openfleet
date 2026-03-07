import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { registerCustomTool } from "../agent/agent-custom-tools.mjs";
import {
  buildCustomCatalog,
  makeCustomToolCanonicalId,
  makeMcpToolCanonicalId,
  parseCanonicalToolId,
  searchCatalogEntries,
} from "../workflow/mcp-discovery-proxy.mjs";
import { wrapServersWithDiscoveryProxy } from "../workflow/mcp-registry.mjs";

const tempRoots = [];

async function makeRoot() {
  const root = resolve(tmpdir(), `bosun-discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    await rm(root, { recursive: true, force: true });
  }
});

describe("mcp discovery proxy helpers", () => {
  it("parses canonical tool ids", () => {
    expect(parseCanonicalToolId(makeCustomToolCanonicalId("lint-helper"))).toEqual({
      kind: "custom",
      toolId: "lint-helper",
    });
    expect(parseCanonicalToolId(makeMcpToolCanonicalId("github", "list_pull_requests"))).toEqual({
      kind: "mcp",
      serverId: "github",
      toolName: "list_pull_requests",
    });
  });

  it("builds a custom tool catalog with canonical ids", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      title: "Lint Helper",
      description: "Runs lint with repo defaults",
      category: "validation",
      lang: "mjs",
      script: "console.log('lint')",
      autoInject: true,
    });
    const catalog = buildCustomCatalog(root);
    const entry = catalog.find((item) => item.canonicalId === makeCustomToolCanonicalId("lint-helper"));
    expect(entry).toBeTruthy();
    expect(entry.inputSchema.properties.args).toBeTruthy();
  });

  it("searches catalog entries by keyword relevance", () => {
    const results = searchCatalogEntries([
      {
        canonicalId: makeMcpToolCanonicalId("github", "list_pull_requests"),
        kind: "mcp",
        serverId: "github",
        toolName: "list_pull_requests",
        description: "List open pull requests",
        tags: ["github", "pr"],
      },
      {
        canonicalId: makeCustomToolCanonicalId("lint-helper"),
        kind: "custom",
        toolId: "lint-helper",
        title: "Lint Helper",
        description: "Run lint",
        tags: ["lint"],
      },
    ], "github pr", 5);
    expect(results[0].canonicalId).toBe(makeMcpToolCanonicalId("github", "list_pull_requests"));
  });

  it("wraps servers with a single discovery proxy and persists config", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      title: "Lint Helper",
      description: "Runs lint with repo defaults",
      category: "validation",
      lang: "mjs",
      script: "console.log('lint')",
    });
    const wrapped = wrapServersWithDiscoveryProxy(root, [
      {
        id: "github",
        name: "GitHub",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
      },
    ], {});
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].id).toBe("bosun-discovery-proxy");
    expect(wrapped[0].args[0]).toContain("mcp-discovery-proxy.mjs");
    expect(existsSync(wrapped[0].env.BOSUN_DISCOVERY_PROXY_CONFIG_PATH)).toBe(true);
  });
});
