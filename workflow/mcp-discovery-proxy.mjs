#!/usr/bin/env node
/**
 * mcp-discovery-proxy.mjs
 *
 * Bosun-local discovery-first MCP wrapper inspired by the discovery flow used
 * by FastMCP Code Mode. Instead of exposing every external MCP tool schema
 * up-front, this proxy exposes three compact tools:
 *   - search
 *   - get_schema
 *   - execute
 *
 * The proxy lazily discovers external MCP tools on demand and also folds in
 * Bosun's expanding custom tool library.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import "../infra/windows-hidden-child-processes.mjs";
import * as mcpClient from "@modelcontextprotocol/sdk/client/index.js";
import * as mcpClientStdio from "@modelcontextprotocol/sdk/client/stdio.js";
import * as mcpClientHttp from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as mcpServer from "@modelcontextprotocol/sdk/server/index.js";
import * as mcpStdio from "@modelcontextprotocol/sdk/server/stdio.js";
import * as mcpHttpServer from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as mcpTypes from "@modelcontextprotocol/sdk/types.js";
import {
  invokeCustomTool,
  listCustomTools,
} from "../agent/agent-custom-tools.mjs";

const Client = mcpClient.Client ?? mcpClient.default?.Client;
const StdioClientTransport =
  mcpClientStdio.StdioClientTransport ??
  mcpClientStdio.default?.StdioClientTransport;
const StreamableHTTPClientTransport =
  mcpClientHttp.StreamableHTTPClientTransport ??
  mcpClientHttp.default?.StreamableHTTPClientTransport;
const Server = mcpServer.Server ?? mcpServer.default?.Server;
const StdioServerTransport =
  mcpStdio.StdioServerTransport ??
  mcpStdio.default?.StdioServerTransport;
const StreamableHTTPServerTransport =
  mcpHttpServer.StreamableHTTPServerTransport ??
  mcpHttpServer.default?.StreamableHTTPServerTransport;
const CallToolRequestSchema =
  mcpTypes.CallToolRequestSchema ??
  mcpTypes.default?.CallToolRequestSchema;
const CallToolResultSchema =
  mcpTypes.CallToolResultSchema ??
  mcpTypes.default?.CallToolResultSchema;
const ListToolsRequestSchema =
  mcpTypes.ListToolsRequestSchema ??
  mcpTypes.default?.ListToolsRequestSchema;
const ListToolsResultSchema =
  mcpTypes.ListToolsResultSchema ??
  mcpTypes.default?.ListToolsResultSchema;
const isInitializeRequest =
  mcpTypes.isInitializeRequest ??
  mcpTypes.default?.isInitializeRequest;

const TAG = "[mcp-discovery-proxy]";
const ResolvedCallToolRequestSchema = CallToolRequestSchema ?? CallToolRequest?.schema;
const ResolvedListToolsRequestSchema = ListToolsRequestSchema ?? ListToolsRequest?.schema;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 10_000;
const DEFAULT_SHARED_HOST_STARTUP_TIMEOUT_MS = 5_000;
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

function renderEntry(entry, detail = "brief") {
  if (detail === "full") {
    return entry;
  }
  if (detail === "detailed") {
    return {
      canonicalId: entry.canonicalId,
      kind: entry.kind,
      description: entry.description || "",
      inputSchema: entry.inputSchema || { type: "object", properties: {} },
      tags: entry.tags || [],
      ...(entry.serverId ? { serverId: entry.serverId, toolName: entry.toolName } : {}),
      ...(entry.toolId ? { toolId: entry.toolId, lang: entry.lang, scope: entry.scope } : {}),
    };
  }
  return {
    canonicalId: entry.canonicalId,
    kind: entry.kind,
    description: entry.description || "",
    ...(entry.serverId ? { serverId: entry.serverId, toolName: entry.toolName } : {}),
    ...(entry.toolId ? { toolId: entry.toolId } : {}),
  };
}

function normalizeDetail(detail, fallback = "brief") {
  const value = normalizeString(detail).toLowerCase();
  return ["brief", "detailed", "full"].includes(value) ? value : fallback;
}

function createDefaultClientFactory({ rootDir, clientName = "bosun-discovery-proxy" } = {}) {
  return async function createClientConnection(server) {
    const client = new Client({
      name: clientName,
      version: "1.0.0",
    });

    const transport = server.transport === "url" && server.url
      ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({
          command: server.command,
          args: Array.isArray(server.args) ? server.args : [],
          env: {
            ...process.env,
            ...(server.env || {}),
          },
          cwd: server.cwd || rootDir,
          stderr: "pipe",
        });

    await client.connect(transport);
    return { client, transport };
  };
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

function createCatalogRuntime(config, options = {}) {
  const rootDir = resolve(config.rootDir || process.cwd());
  const servers = Array.isArray(config.servers) ? config.servers : [];
  const toolCache = new Map();
  const connectionCache = new Map();
  const cacheTtlMs = Number(config.cacheTtlMs) || DEFAULT_CACHE_TTL_MS;
  const executeTimeoutMs = Number(config.executeTimeoutMs) || DEFAULT_EXECUTE_TIMEOUT_MS;
  const customCatalog = buildCustomCatalog(rootDir);
  const clientFactory =
    typeof options.clientFactory === "function"
      ? options.clientFactory
      : createDefaultClientFactory({ rootDir });

  async function closeConnection(serverId, expected = null) {
    const cached = connectionCache.get(serverId);
    if (!cached) return;
    if (expected && cached !== expected) return;
    connectionCache.delete(serverId);
    const resolved = await cached.catch(() => null);
    const transport = resolved?.transport || null;
    if (!transport) return;
    try {
      if (typeof transport.terminateSession === "function") {
        await transport.terminateSession().catch(() => {});
      }
      await transport.close();
    } catch {
      /* best effort */
    }
  }

  async function getConnection(server) {
    const cached = connectionCache.get(server.id);
    if (cached) {
      return await cached;
    }
    const pending = (async () => {
      const connection = await clientFactory(server);
      if (connection?.transport) {
        connection.transport.onclose = () => {
          connectionCache.delete(server.id);
        };
      }
      return connection;
    })();
    connectionCache.set(server.id, pending);
    try {
      return await pending;
    } catch (error) {
      connectionCache.delete(server.id);
      throw error;
    }
  }

  async function requestServer(server, operation, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await getConnection(server);
      try {
        return await new Promise((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => {
            rejectPromise(new Error(`Timed out waiting for ${server.id}`));
          }, timeoutMs);
          if (typeof timer?.unref === "function") timer.unref();
          Promise.resolve(operation(connection.client, timeoutMs))
            .then((value) => {
              clearTimeout(timer);
              resolvePromise(value);
            })
            .catch((error) => {
              clearTimeout(timer);
              rejectPromise(error);
            });
        });
      } catch (error) {
        lastError = error;
        await closeConnection(server.id, connectionCache.get(server.id));
      }
    }
    throw lastError || new Error(`Server ${server.id} request failed`);
  }

  async function getServerTools(server) {
    const cached = toolCache.get(server.id);
    if (cached && (Date.now() - cached.ts) < cacheTtlMs) {
      return cached.tools;
    }
    const result = await requestServer(
      server,
      async (client) => client.listTools({}, { timeout: config.timeoutMs || DEFAULT_TIMEOUT_MS }),
      config.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
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
    toolCache.set(server.id, { ts: Date.now(), tools: mapped });
    return mapped;
  }

  async function getCatalogEntries(kind = "all") {
    const results = [];
    if (kind === "all" || kind === TOOL_KIND_CUSTOM) {
      results.push(...customCatalog);
    }
    if (kind === "all" || kind === TOOL_KIND_MCP) {
      const serverToolSets = await Promise.all(servers.map((server) => getServerTools(server)));
      for (const set of serverToolSets) results.push(...set);
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
      async (client) =>
        client.callTool(
          { name: parsed.toolName, arguments: args || {} },
          CallToolResultSchema,
          { timeout: timeoutMs },
        ),
      timeoutMs,
    );
    return {
      kind: TOOL_KIND_MCP,
      serverId: parsed.serverId,
      toolName: parsed.toolName,
      result,
    };
  }

  async function executeCode(source, timeoutMs = executeTimeoutMs) {
    const trimmed = normalizeString(source);
    if (!trimmed) throw new Error("execute: source is required");
    const sandbox = {
      result: undefined,
      console: Object.freeze({
        log: (...args) => args.map((item) => String(item)).join(" "),
      }),
    };
    const callTool = async (toolId, args = {}) => {
      const entry = await getEntry(toolId);
      if (!entry) throw new Error(`Unknown tool: ${toolId}`);
      const result = await callEntry(toolId, args, timeoutMs);
      if (result.kind === TOOL_KIND_CUSTOM) {
        return result.result;
      }
      if (result.result?.structuredContent != null) return result.result.structuredContent;
      if (Array.isArray(result.result?.content)) {
        return result.result.content
          .map((item) => item?.text || "")
          .filter(Boolean)
          .join("\n");
      }
      return result.result;
    };
    const wrapped = `
      (async () => {
        ${source}
      })()
    `;
    const context = vm.createContext({
      ...sandbox,
      callTool,
    });
    const script = new vm.Script(wrapped, {
      filename: "bosun-discovery-proxy-execute.vm",
    });
    return await script.runInContext(context, { timeout: timeoutMs });
  }

  return {
    rootDir,
    servers,
    getCatalogEntries,
    getEntry,
    callEntry,
    executeCode,
    async close() {
      const ids = Array.from(connectionCache.keys());
      await Promise.all(ids.map((serverId) => closeConnection(serverId)));
    },
  };
}

function buildSearchText(matches) {
  if (!matches.length) return "No tools matched the query.";
  return matches.map(summarizeToolMatch).join("\n");
}

function createDiscoveryProxyServer(runtime, config = {}) {
  const server = new Server(
    { name: "bosun-discovery-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ResolvedListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search",
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
            detail: {
              type: "string",
              enum: ["brief", "detailed", "full"],
              description: "Verbosity of returned tool metadata.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_schema",
        description: "Get the concrete schema and metadata for one or more discovered tools before calling them.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string", description: "Canonical tool ID from search." },
            tools: {
              type: "array",
              items: { type: "string" },
              description: "Canonical tool IDs from search.",
            },
            detail: {
              type: "string",
              enum: ["brief", "detailed", "full"],
              description: "Verbosity of returned schema data.",
            },
          },
          anyOf: [
            { required: ["toolId"] },
            { required: ["tools"] },
          ],
        },
      },
      {
        name: "execute",
        description: "Execute JavaScript that calls discovered tools with await callTool(toolId, args), returning only the final result.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "Async JavaScript body using await callTool(toolId, args)." },
            timeoutMs: { type: "number", description: "Optional timeout override." },
          },
          required: ["code"],
        },
      },
      {
        name: "call_discovered_tool",
        description: "Invoke a discovered MCP tool or Bosun custom tool by canonical tool ID directly.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string", description: "Canonical tool ID from search." },
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

  server.setRequestHandler(ResolvedCallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "search" || name === "search_tools") {
      const kind = normalizeString(args?.kind || "all").toLowerCase() || "all";
      const limit = Number(args?.limit) || 10;
      const detail = normalizeDetail(args?.detail, "brief");
      const entries = await runtime.getCatalogEntries(kind);
      const matches = searchCatalogEntries(entries, args?.query, limit);
      const renderedMatches = matches.map((entry) => renderEntry(entry, detail));
      return {
        content: [{ type: "text", text: buildSearchText(matches) }],
        structuredContent: {
          query: normalizeString(args?.query),
          count: matches.length,
          matches: renderedMatches,
        },
      };
    }

    if (name === "get_schema" || name === "get_tool_schema") {
      const requested = Array.isArray(args?.tools)
        ? args.tools.map((item) => normalizeString(item)).filter(Boolean)
        : [];
      if (requested.length === 0 && args?.toolId) requested.push(normalizeString(args.toolId));
      const detail = normalizeDetail(args?.detail, "detailed");
      const resolved = await Promise.all(requested.map((toolId) => runtime.getEntry(toolId)));
      const entries = resolved.filter(Boolean).map((entry) => renderEntry(entry, detail));
      if (entries.length === 0) throw new Error(`Tool not found: ${args?.toolId || requested.join(", ")}`);
      return {
        content: [{ type: "text", text: formatTextResult(entries.length === 1 ? entries[0] : entries) }],
        structuredContent: {
          count: entries.length,
          tools: entries,
        },
      };
    }

    if (name === "execute") {
      const result = await runtime.executeCode(
        args?.code,
        Number(args?.timeoutMs) || Number(config.executeTimeoutMs) || DEFAULT_EXECUTE_TIMEOUT_MS,
      );
      return {
        content: [{ type: "text", text: formatTextResult(result) }],
        structuredContent: { result },
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

  return server;
}

function parseSharedHostArgs() {
  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf("--shared-host");
  if (flagIndex === -1) {
    return null;
  }
  return {
    configPath: normalizeString(argv[flagIndex + 1]),
    statePath: normalizeString(argv[flagIndex + 2]),
  };
}

function writeSharedHostState(statePath, payload) {
  if (!statePath) return;
  writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function runSharedHost() {
  const args = parseSharedHostArgs();
  if (!args?.configPath || !args?.statePath) {
    throw new Error(`${TAG} shared host requires config and state paths`);
  }

  const previousStatePath = process.env.BOSUN_DISCOVERY_HOST_STATE_PATH;
  process.env.BOSUN_DISCOVERY_PROXY_CONFIG_PATH = args.configPath;
  process.env.BOSUN_DISCOVERY_HOST_STATE_PATH = args.statePath;

  const config = parseProxyConfig();
  const runtime = createCatalogRuntime(config);
  const sessions = new Map();
  const host = normalizeString(process.env.BOSUN_DISCOVERY_HOST || "127.0.0.1") || "127.0.0.1";

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.pathname === "/health") {
        const body = JSON.stringify({
          ok: true,
          pid: process.pid,
          sessionCount: sessions.size,
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const sessionId = normalizeString(req.headers["mcp-session-id"]);
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        let entry = sessionId ? sessions.get(sessionId) : null;
        if (!entry) {
          if (sessionId || !isInitializeRequest?.(body)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
              },
              id: body?.id ?? null,
            }));
            return;
          }

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (createdSessionId) => {
              sessions.set(createdSessionId, { transport, proxyServer });
            },
          });
          const proxyServer = createDiscoveryProxyServer(runtime, config);
          transport.onclose = () => {
            const currentSessionId = transport.sessionId;
            if (currentSessionId) {
              sessions.delete(currentSessionId);
            }
          };
          await proxyServer.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        await entry.transport.handleRequest(req, res, body);
        return;
      }

      if ((req.method === "GET" || req.method === "DELETE") && sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          res.writeHead(400);
          res.end("Invalid or missing session ID");
          return;
        }
        await entry.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405);
      res.end("Method not allowed");
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(0, host, resolvePromise);
  });

  const address = httpServer.address();
  if (!address || typeof address !== "object" || !address.port) {
    throw new Error(`${TAG} shared host failed to bind`);
  }
  const state = {
    ok: true,
    pid: process.pid,
    host,
    port: address.port,
    url: `http://${host}:${address.port}/mcp`,
    configPath: args.configPath,
    statePath: args.statePath,
    startedAt: new Date().toISOString(),
  };
  writeSharedHostState(args.statePath, state);

  const shutdown = async () => {
    try {
      httpServer.close();
    } catch {
      /* best effort */
    }
    const entries = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(entries.map(async ({ transport }) => {
      try {
        await transport.close();
      } catch {
        /* best effort */
      }
    }));
    await runtime.close().catch(() => {});
    if (existsSync(args.statePath)) {
      try {
        unlinkSync(args.statePath);
      } catch {
        /* best effort */
      }
    }
    if (previousStatePath === undefined) {
      delete process.env.BOSUN_DISCOVERY_HOST_STATE_PATH;
    } else {
      process.env.BOSUN_DISCOVERY_HOST_STATE_PATH = previousStatePath;
    }
  };

  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
}

async function main() {
  const config = parseProxyConfig();
  const runtime = createCatalogRuntime(config);
  const server = createDiscoveryProxyServer(runtime, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await runtime.close().catch(() => {});
  };
  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
}

const executedAsScript = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executedAsScript) {
  const runner = process.argv.includes("--shared-host") ? runSharedHost : main;
  runner().catch((error) => {
    console.error(`${TAG} ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

export {
  createCatalogRuntime,
  createDefaultClientFactory,
  createDiscoveryProxyServer,
  main,
  runSharedHost,
};
