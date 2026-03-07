#!/usr/bin/env node
/**
 * mcp-discovery-proxy.mjs
 *
 * Bosun-local discovery-first MCP wrapper inspired by the discovery flow used
 * by FastMCP Code Mode. Instead of exposing every external MCP tool schema
 * up-front, this proxy exposes three compact tools:
 *   - search_tools
 *   - get_tool_schema
 *   - call_discovered_tool
 *
 * The proxy lazily discovers external MCP tools on demand and also folds in
 * Bosun's expanding custom tool library.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getCustomTool,
  invokeCustomTool,
  listCustomTools,
} from "../agent/agent-custom-tools.mjs";

const TAG = "[mcp-discovery-proxy]";
const DEFAULT_TIMEOUT_MS = 30_000;
const TOOL_KIND_MCP = "mcp";
const TOOL_KIND_CUSTOM = "custom";

function normalizeString(value) {
  return String(value || "").trim();
}

function parseProxyConfig() {
  const configPath = normalizeString(
    process.env.BOSUN_DISCOVERY_PROXY_CONFIG_PATH || process.argv[2],
  );
  if (!configPath) {
    throw new Error(`${TAG} missing config path`);
  }
  const raw = readFileSync(resolve(configPath), "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function makeCustomToolCanonicalId(toolId) {
  return `custom:${normalizeString(toolId)}`;
}

export function makeMcpToolCanonicalId(serverId, toolName) {
  return `mcp:${normalizeString(serverId)}:${normalizeString(toolName)}`;
}

export function parseCanonicalToolId(toolId) {
  const raw = normalizeString(toolId);
  if (!raw) return null;
  if (raw.startsWith("custom:")) {
    return {
      kind: TOOL_KIND_CUSTOM,
      toolId: raw.slice("custom:".length),
    };
  }
  if (raw.startsWith("mcp:")) {
    const parts = raw.split(":");
    if (parts.length >= 3) {
      return {
        kind: TOOL_KIND_MCP,
        serverId: parts[1],
        toolName: parts.slice(2).join(":"),
      };
    }
  }
  return null;
}

function formatTextResult(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolMatch(entry) {
  const location = entry.kind === TOOL_KIND_MCP
    ? `${entry.serverId}/${entry.toolName}`
    : `${entry.toolId}.${entry.lang || "tool"}`;
  const tags = Array.isArray(entry.tags) && entry.tags.length > 0
    ? ` tags=${entry.tags.join(",")}`
    : "";
  return `- ${entry.canonicalId} :: ${location} :: ${entry.description || "No description"}${tags}`;
}

function toolSearchScore(entry, tokens) {
  const haystack = [
    entry.canonicalId,
    entry.serverId,
    entry.toolName,
    entry.toolId,
    entry.title,
    entry.description,
    ...(entry.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function searchCatalogEntries(entries, query, limit = 10) {
  const tokens = normalizeString(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const scored = entries
    .map((entry) => ({ entry, score: tokens.length > 0 ? toolSearchScore(entry, tokens) : 1 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      String(a.entry.canonicalId).localeCompare(String(b.entry.canonicalId)))
    .slice(0, Math.max(1, Math.trunc(limit || 10)));
  return scored.map(({ entry }) => entry);
}

function createStdioRequest(server, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(server.command, server.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(server.env || {}),
      },
    });

    let settled = false;
    let initialized = false;
    let buffer = "";
    let requestId = 1;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      fn(value);
    };

    const sendJson = (payload) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const timer = setTimeout(() => {
      finish(rejectPromise, new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg?.id === 1 && msg?.result && !initialized) {
          initialized = true;
          sendJson({ jsonrpc: "2.0", method: "notifications/initialized" });
          requestId += 1;
          sendJson({
            jsonrpc: "2.0",
            id: requestId,
            method,
            params,
          });
          continue;
        }
        if (msg?.id === requestId) {
          if (msg.error) {
            finish(rejectPromise, new Error(msg.error.message || `${method} failed`));
          } else {
            finish(resolvePromise, msg.result || {});
          }
        }
      }
    });

    child.stderr.on("data", () => {
      /* stderr is ignored; result errors are surfaced via JSON-RPC */
    });

    child.on("error", (error) => finish(rejectPromise, error));
    child.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish(rejectPromise, new Error(`Server exited with code ${code}`));
      }
    });

    sendJson({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bosun-discovery-proxy", version: "1.0.0" },
      },
    });
  });
}

async function createUrlRequest(url, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (payload?.error) {
      throw new Error(payload.error.message || `${method} failed`);
    }
    return payload?.result || {};
  } finally {
    clearTimeout(timer);
  }
}

async function requestServer(server, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (server.transport === "url" && server.url) {
    return createUrlRequest(server.url, method, params, timeoutMs);
  }
  if (server.command) {
    return createStdioRequest(server, method, params, timeoutMs);
  }
  throw new Error(`Server ${server.id} is missing transport details`);
}

export function buildCustomCatalog(rootDir) {
  return listCustomTools(rootDir, { includeGlobal: true, includeBuiltins: true }).map((tool) => ({
    canonicalId: makeCustomToolCanonicalId(tool.id),
    kind: TOOL_KIND_CUSTOM,
    toolId: tool.id,
    title: tool.title,
    description: tool.description,
    tags: tool.tags || [],
    lang: tool.lang,
    scope: tool.scope,
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "CLI arguments passed to the custom tool script.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout override in milliseconds.",
        },
      },
      additionalProperties: false,
    },
  }));
}

function createCatalogRuntime(config) {
  const rootDir = resolve(config.rootDir || process.cwd());
  const servers = Array.isArray(config.servers) ? config.servers : [];
  const toolCache = new Map();
  const customCatalog = buildCustomCatalog(rootDir);

  async function getServerTools(server) {
    if (toolCache.has(server.id)) return toolCache.get(server.id);
    const result = await requestServer(server, "tools/list", {}, config.timeoutMs || DEFAULT_TIMEOUT_MS);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const mapped = tools.map((tool) => ({
      canonicalId: makeMcpToolCanonicalId(server.id, tool.name),
      kind: TOOL_KIND_MCP,
      serverId: server.id,
      serverName: server.name || server.id,
      toolName: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || { type: "object", properties: {} },
      tags: server.tags || [],
    }));
    toolCache.set(server.id, mapped);
    return mapped;
  }

  async function getCatalogEntries(kind = "all") {
    const results = [];
    if (kind === "all" || kind === TOOL_KIND_CUSTOM) {
      results.push(...customCatalog);
    }
    if (kind === "all" || kind === TOOL_KIND_MCP) {
      for (const server of servers) {
        results.push(...await getServerTools(server));
      }
    }
    return results;
  }

  async function getEntry(toolId) {
    const parsed = parseCanonicalToolId(toolId);
    if (!parsed) return null;
    if (parsed.kind === TOOL_KIND_CUSTOM) {
      return customCatalog.find((entry) => entry.toolId === parsed.toolId) || null;
    }
    const server = servers.find((item) => item.id === parsed.serverId);
    if (!server) return null;
    const tools = await getServerTools(server);
    return tools.find((entry) => entry.toolName === parsed.toolName) || null;
  }

  async function callEntry(toolId, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const parsed = parseCanonicalToolId(toolId);
    if (!parsed) throw new Error(`Unknown toolId: ${toolId}`);
    if (parsed.kind === TOOL_KIND_CUSTOM) {
      const cliArgs = Array.isArray(args?.args)
        ? args.args.map((value) => String(value))
        : [];
      const result = await invokeCustomTool(rootDir, parsed.toolId, cliArgs, {
        cwd: rootDir,
        timeout: Number(args?.timeoutMs) || timeoutMs,
      });
      return {
        kind: TOOL_KIND_CUSTOM,
        toolId: parsed.toolId,
        result,
      };
    }
    const server = servers.find((item) => item.id === parsed.serverId);
    if (!server) throw new Error(`MCP server not found: ${parsed.serverId}`);
    const result = await requestServer(
      server,
      "tools/call",
      { name: parsed.toolName, arguments: args || {} },
      timeoutMs,
    );
    return {
      kind: TOOL_KIND_MCP,
      serverId: parsed.serverId,
      toolName: parsed.toolName,
      result,
    };
  }

  return {
    rootDir,
    servers,
    getCatalogEntries,
    getEntry,
    callEntry,
  };
}

function buildSearchText(matches) {
  if (!matches.length) return "No tools matched the query.";
  return matches.map(summarizeToolMatch).join("\n");
}

async function main() {
  const config = parseProxyConfig();
  const runtime = createCatalogRuntime(config);
  const server = new Server(
    { name: "bosun-discovery-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_tools",
        description: "Search Bosun custom tools and wrapped MCP tools by keyword before loading schemas.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword query for tool discovery." },
            kind: {
              type: "string",
              enum: ["all", "mcp", "custom"],
              description: "Restrict search to wrapped MCP tools or custom tools.",
            },
            limit: { type: "number", description: "Maximum number of matches to return." },
          },
          required: ["query"],
        },
      },
      {
        name: "get_tool_schema",
        description: "Get the concrete schema and metadata for one discovered tool before calling it.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string", description: "Canonical tool ID from search_tools." },
          },
          required: ["toolId"],
        },
      },
      {
        name: "call_discovered_tool",
        description: "Invoke a discovered MCP tool or Bosun custom tool by canonical tool ID.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string", description: "Canonical tool ID from search_tools." },
            arguments: {
              type: "object",
              description: "Arguments object for MCP tools, or { args: [] } for custom tools.",
            },
            timeoutMs: { type: "number", description: "Optional timeout override." },
          },
          required: ["toolId"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "search_tools") {
      const kind = normalizeString(args?.kind || "all").toLowerCase() || "all";
      const limit = Number(args?.limit) || 10;
      const entries = await runtime.getCatalogEntries(kind);
      const matches = searchCatalogEntries(entries, args?.query, limit);
      return {
        content: [{ type: "text", text: buildSearchText(matches) }],
        structuredContent: {
          query: normalizeString(args?.query),
          count: matches.length,
          matches,
        },
      };
    }

    if (name === "get_tool_schema") {
      const entry = await runtime.getEntry(args?.toolId);
      if (!entry) {
        throw new Error(`Tool not found: ${args?.toolId || ""}`);
      }
      return {
        content: [{ type: "text", text: formatTextResult(entry) }],
        structuredContent: entry,
      };
    }

    if (name === "call_discovered_tool") {
      const result = await runtime.callEntry(
        args?.toolId,
        args?.arguments && typeof args.arguments === "object" ? args.arguments : {},
        Number(args?.timeoutMs) || config.timeoutMs || DEFAULT_TIMEOUT_MS,
      );
      const payload = result?.result || result;
      return {
        content: [{ type: "text", text: formatTextResult(payload) }],
        structuredContent: result,
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const executedAsScript = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executedAsScript) {
  main().catch((error) => {
    console.error(`${TAG} ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

export {
  createCatalogRuntime,
  main,
};
