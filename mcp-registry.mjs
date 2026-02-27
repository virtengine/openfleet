/**
 * mcp-registry.mjs — Centralized MCP Server Registry & Management
 *
 * Provides a curated catalog of popular MCP servers that can be installed
 * with one click, plus helpers to resolve installed servers for injection
 * into agent launches (Codex config.toml, Copilot CLI args, Claude env).
 *
 * Storage: installed servers are persisted as `type: "mcp"` entries in the
 * existing library system (`.bosun/mcp-servers/*.json` + `library.json`).
 *
 * EXPORTS:
 *   CURATED_MCP_CATALOG       — frozen array of known-good MCP server defs
 *   listCatalog()             — read-only catalog query
 *   getCatalogEntry(id)       — single catalog entry by ID
 *   installMcpServer()        — one-click install from catalog or custom def
 *   uninstallMcpServer()      — remove an installed server
 *   listInstalledMcpServers() — all installed MCP servers
 *   getInstalledMcpServer()   — single installed server by ID
 *   resolveMcpServersForAgent() — resolve IDs to full configs for SDK injection
 *   buildCodexMcpToml()       — convert configs → Codex TOML blocks
 *   buildCopilotMcpJson()     — convert configs → Copilot MCP JSON
 *   buildClaudeMcpEnv()       — convert configs → Claude MCP env format
 */

import { resolve, join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Lazy-import library manager to avoid circular dependency at module load.
// Cached at module scope per AGENTS.md hard rules.
let _libManager = null;
async function getLibManager() {
  if (!_libManager) {
    _libManager = await import("./library-manager.mjs");
  }
  return _libManager;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TAG = "[mcp-registry]";

/**
 * Curated catalog of popular, reliable MCP servers.
 * Each entry describes how to launch or connect to the server.
 *
 * Transport types:
 *   "stdio"  — launch via command+args, communicate over stdin/stdout
 *   "url"    — connect to a remote HTTP/SSE endpoint
 */
export const CURATED_MCP_CATALOG = Object.freeze([
  // ── Official / Microsoft / GitHub ────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    description: "GitHub API — repositories, issues, PRs, code search, actions",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    tags: ["github", "vcs", "official"],
    source: "catalog",
    homepage: "https://github.com/anthropics/github-mcp-server",
  },
  {
    id: "microsoft-docs",
    name: "Microsoft Docs",
    description: "Microsoft Learn documentation search and retrieval",
    transport: "url",
    url: "https://learn.microsoft.com/api/mcp",
    tags: ["docs", "microsoft", "official"],
    source: "catalog",
    homepage: "https://learn.microsoft.com",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date library documentation and code examples",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    tags: ["docs", "libraries", "community"],
    source: "catalog",
    homepage: "https://github.com/nicepkg/context7",
  },
  // ── Official MCP Reference Servers ───────────────────────────────────────
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Dynamic, reflective problem-solving through structured thought sequences",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    tags: ["reasoning", "official"],
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Secure file system operations with configurable access controls",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    tags: ["filesystem", "official"],
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Web content fetching and conversion for efficient LLM usage",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    tags: ["web", "http", "official"],
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "memory",
    name: "Memory",
    description: "Knowledge graph-based persistent memory for entities and relations",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    tags: ["memory", "knowledge-graph", "official"],
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read-only PostgreSQL database access with schema inspection",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    env: { POSTGRES_CONNECTION_STRING: "" },
    tags: ["database", "postgres", "official"],
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  // ── Browser / UI Testing ────────────────────────────────────────────────
  {
    id: "playwright",
    name: "Playwright",
    description: "Browser automation — navigate, interact, screenshot, test web apps",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    tags: ["browser", "testing", "automation", "official"],
    source: "catalog",
    homepage: "https://github.com/nicholasrq/playwright-mcp",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Chrome automation via Puppeteer for browser control and screenshots",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-puppeteer"],
    tags: ["browser", "testing", "screenshot"],
    source: "catalog",
    homepage: "https://github.com/anthropics/puppeteer-mcp-server",
  },
  // ── Search / Knowledge ──────────────────────────────────────────────────
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web and local search using the Brave Search API",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-brave-search"],
    env: { BRAVE_API_KEY: "" },
    tags: ["search", "web"],
    source: "catalog",
    homepage: "https://github.com/anthropics/brave-search-mcp-server",
  },
  {
    id: "exa",
    name: "Exa Search",
    description: "Neural search engine for precise, up-to-date web results",
    transport: "stdio",
    command: "npx",
    args: ["-y", "exa-mcp-server"],
    env: { EXA_API_KEY: "" },
    tags: ["search", "web", "ai"],
    source: "catalog",
    homepage: "https://github.com/nicepkg/exa-mcp-server",
  },
  // ── Productivity / Project Management ───────────────────────────────────
  {
    id: "linear",
    name: "Linear",
    description: "Linear project management — issues, projects, teams",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-linear"],
    env: { LINEAR_API_KEY: "" },
    tags: ["project-management", "issues"],
    source: "catalog",
    homepage: "https://github.com/nicepkg/mcp-linear",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack workspace messaging, channels, and search",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-slack"],
    env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    tags: ["messaging", "slack"],
    source: "catalog",
    homepage: "https://github.com/anthropics/slack-mcp-server",
  },
  // ── Storage / Cloud ─────────────────────────────────────────────────────
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Google Drive file search and retrieval",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-google-drive"],
    tags: ["cloud", "storage", "google"],
    source: "catalog",
    homepage: "https://github.com/anthropics/google-drive-mcp-server",
  },
  // ── Vibe Kanban (Bosun built-in) ────────────────────────────────────────
  {
    id: "vibe-kanban",
    name: "Vibe Kanban",
    description: "Bosun's integrated task and project management MCP server",
    transport: "stdio",
    command: "npx",
    args: ["-y", "vibe-kanban@latest"],
    env: { VK_BASE_URL: "http://127.0.0.1:54089" },
    tags: ["kanban", "tasks", "bosun"],
    source: "catalog",
    homepage: "https://github.com/nicepkg/vibe-kanban",
  },
]);

// ── Catalog Queries ───────────────────────────────────────────────────────────

/**
 * List all catalog entries, optionally filtered by tags.
 * @param {{ tags?: string[] }} [options]
 * @returns {ReadonlyArray<Object>}
 */
export function listCatalog({ tags } = {}) {
  if (!tags || !tags.length) return CURATED_MCP_CATALOG;
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  return CURATED_MCP_CATALOG.filter((entry) =>
    entry.tags.some((t) => tagSet.has(t.toLowerCase())),
  );
}

/**
 * Get a single catalog entry by ID.
 * @param {string} id
 * @returns {Object|null}
 */
export function getCatalogEntry(id) {
  const normalized = String(id || "").trim().toLowerCase();
  return CURATED_MCP_CATALOG.find((e) => e.id === normalized) || null;
}

// ── Install / Uninstall ───────────────────────────────────────────────────────

/**
 * Install an MCP server from the catalog or a custom definition.
 *
 * Catalog install:
 *   installMcpServer(rootDir, "github")
 *
 * Custom install:
 *   installMcpServer(rootDir, { id: "my-server", name: "My Server", ... })
 *
 * @param {string} rootDir — workspace root
 * @param {string|Object} catalogIdOrDef — catalog ID string or full server def
 * @param {{ envOverrides?: Object }} [options]
 * @returns {Promise<Object>} — the created library entry
 */
export async function installMcpServer(rootDir, catalogIdOrDef, { envOverrides } = {}) {
  const lib = await getLibManager();

  let serverDef;
  if (typeof catalogIdOrDef === "string") {
    const catalogEntry = getCatalogEntry(catalogIdOrDef);
    if (!catalogEntry) {
      throw new Error(`${TAG} MCP server "${catalogIdOrDef}" not found in catalog. Use listCatalog() to see available servers.`);
    }
    // Clone catalog entry so we don't mutate the frozen original
    serverDef = { ...catalogEntry };
  } else if (catalogIdOrDef && typeof catalogIdOrDef === "object") {
    serverDef = { ...catalogIdOrDef };
    if (!serverDef.id) serverDef.id = serverDef.name ? slugify(serverDef.name) : `custom-${randomUUID().slice(0, 8)}`;
    if (!serverDef.name) serverDef.name = serverDef.id;
    serverDef.source = serverDef.source || "custom";
  } else {
    throw new Error(`${TAG} installMcpServer requires a catalog ID string or server definition object`);
  }

  // Apply environment overrides
  if (envOverrides && typeof envOverrides === "object") {
    serverDef.env = { ...(serverDef.env || {}), ...envOverrides };
  }

  // Persist via library manager as type "mcp"
  const entry = lib.upsertEntry(rootDir, {
    type: "mcp",
    id: serverDef.id,
    name: serverDef.name,
    description: serverDef.description || "",
    tags: serverDef.tags || [],
    meta: {
      transport: serverDef.transport || "stdio",
      command: serverDef.command || null,
      args: serverDef.args || [],
      url: serverDef.url || null,
      env: serverDef.env || {},
      source: serverDef.source || "catalog",
      homepage: serverDef.homepage || null,
    },
  }, serverDef);

  console.log(`${TAG} Installed MCP server: ${entry.id} (${serverDef.transport})`);
  return entry;
}

/**
 * Uninstall an MCP server by ID.
 * @param {string} rootDir
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function uninstallMcpServer(rootDir, id) {
  const lib = await getLibManager();
  const removed = lib.deleteEntry(rootDir, id, { deleteFile: true });
  if (removed) {
    console.log(`${TAG} Uninstalled MCP server: ${id}`);
  }
  return removed;
}

/**
 * List all installed MCP servers.
 * @param {string} rootDir
 * @returns {Promise<Array<Object>>}
 */
export async function listInstalledMcpServers(rootDir) {
  const lib = await getLibManager();
  return lib.listEntries(rootDir, { type: "mcp" });
}

/**
 * Get a single installed MCP server by ID.
 * @param {string} rootDir
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getInstalledMcpServer(rootDir, id) {
  const lib = await getLibManager();
  const entry = lib.getEntry(rootDir, id);
  if (!entry || entry.type !== "mcp") return null;
  // Merge entry metadata with file content to get full config
  const content = lib.getEntryContent(rootDir, entry);
  return { ...entry, serverConfig: content };
}

// ── Agent Launch Resolution ───────────────────────────────────────────────────

/**
 * Resolve an array of MCP server IDs into full server configurations
 * ready for injection into SDK adapters.
 *
 * @param {string} rootDir
 * @param {string[]} mcpServerIds — array of installed server IDs
 * @param {{ defaultServers?: string[], catalogOverrides?: Object }} [options]
 * @returns {Promise<Array<Object>>} — resolved server configs
 */
export async function resolveMcpServersForAgent(rootDir, mcpServerIds = [], options = {}) {
  const { defaultServers = [], catalogOverrides = {} } = options;

  // Merge requested IDs with defaults (deduplicate)
  const allIds = [...new Set([...defaultServers, ...mcpServerIds])];
  if (!allIds.length) return [];

  const lib = await getLibManager();
  const resolved = [];

  for (const id of allIds) {
    const entry = lib.getEntry(rootDir, id);
    if (entry && entry.type === "mcp") {
      const content = lib.getEntryContent(rootDir, entry);
      const config = content || entry.meta || {};
      // Apply per-server catalog overrides (e.g. env vars)
      if (catalogOverrides[id]) {
        config.env = { ...(config.env || {}), ...catalogOverrides[id] };
      }
      resolved.push({
        id: entry.id,
        name: entry.name,
        transport: config.transport || entry.meta?.transport || "stdio",
        command: config.command || entry.meta?.command || null,
        args: config.args || entry.meta?.args || [],
        url: config.url || entry.meta?.url || null,
        env: config.env || entry.meta?.env || {},
      });
    } else {
      // Check catalog as fallback (auto-install from catalog)
      const catalogEntry = getCatalogEntry(id);
      if (catalogEntry) {
        const config = { ...catalogEntry };
        if (catalogOverrides[id]) {
          config.env = { ...(config.env || {}), ...catalogOverrides[id] };
        }
        resolved.push({
          id: config.id,
          name: config.name,
          transport: config.transport,
          command: config.command || null,
          args: config.args || [],
          url: config.url || null,
          env: config.env || {},
        });
      } else {
        console.warn(`${TAG} MCP server "${id}" not found (installed or catalog), skipping`);
      }
    }
  }

  return resolved;
}

// ── SDK-Specific Format Builders ──────────────────────────────────────────────

/**
 * Convert resolved MCP server configs into Codex CLI config.toml format.
 *
 * Example output:
 *   [mcp_servers.github]
 *   command = "npx"
 *   args = ["-y", "@anthropic/mcp-github"]
 *   [mcp_servers.github.env]
 *   GITHUB_PERSONAL_ACCESS_TOKEN = "..."
 *
 * @param {Array<Object>} servers — resolved server configs
 * @returns {string} — TOML string
 */
export function buildCodexMcpToml(servers) {
  if (!servers || !servers.length) return "";

  const lines = [];
  for (const srv of servers) {
    const safeId = String(srv.id).replace(/[^a-zA-Z0-9_-]/g, "_");

    if (srv.transport === "url" && srv.url) {
      lines.push("");
      lines.push(`[mcp_servers.${safeId}]`);
      lines.push(`url = ${toTomlString(srv.url)}`);
    } else if (srv.command) {
      lines.push("");
      lines.push(`[mcp_servers.${safeId}]`);
      lines.push(`command = ${toTomlString(srv.command)}`);
      if (srv.args && srv.args.length) {
        const argsStr = srv.args.map((a) => toTomlString(a)).join(", ");
        lines.push(`args = [${argsStr}]`);
      }
    } else {
      continue; // Skip servers without command or url
    }

    // Write env block if present (skip empty-value keys)
    const envEntries = Object.entries(srv.env || {}).filter(
      ([, v]) => v != null && String(v).trim() !== "",
    );
    if (envEntries.length) {
      lines.push(`[mcp_servers.${safeId}.env]`);
      for (const [key, value] of envEntries) {
        lines.push(`${key} = ${toTomlString(String(value))}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Convert resolved MCP server configs into Copilot SDK MCP JSON config.
 * Written as a temp file and passed via --additional-mcp-config.
 *
 * @param {Array<Object>} servers — resolved server configs
 * @returns {Object} — { mcpServers: { [id]: { command, args, env? } | { url } } }
 */
export function buildCopilotMcpJson(servers) {
  if (!servers || !servers.length) return { mcpServers: {} };

  const mcpServers = {};
  for (const srv of servers) {
    if (srv.transport === "url" && srv.url) {
      mcpServers[srv.id] = { url: srv.url };
    } else if (srv.command) {
      const entry = { command: srv.command };
      if (srv.args && srv.args.length) entry.args = srv.args;
      const envEntries = Object.entries(srv.env || {}).filter(
        ([, v]) => v != null && String(v).trim() !== "",
      );
      if (envEntries.length) entry.env = Object.fromEntries(envEntries);
      mcpServers[srv.id] = entry;
    }
  }

  return { mcpServers };
}

/**
 * Convert resolved MCP server configs into Claude Code MCP environment format.
 * Claude Code uses CLAUDE_MCP_SERVERS env var (JSON) or .claude/mcp_servers.json.
 *
 * @param {Array<Object>} servers — resolved server configs
 * @returns {{ envVar: string, fileContent: Object }} — env var value + file format
 */
export function buildClaudeMcpEnv(servers) {
  if (!servers || !servers.length) {
    return { envVar: "", fileContent: { mcpServers: {} } };
  }

  const mcpServers = {};
  for (const srv of servers) {
    if (srv.transport === "url" && srv.url) {
      mcpServers[srv.id] = { type: "url", url: srv.url };
    } else if (srv.command) {
      const entry = { type: "stdio", command: srv.command };
      if (srv.args && srv.args.length) entry.args = srv.args;
      const envEntries = Object.entries(srv.env || {}).filter(
        ([, v]) => v != null && String(v).trim() !== "",
      );
      if (envEntries.length) entry.env = Object.fromEntries(envEntries);
      mcpServers[srv.id] = entry;
    }
  }

  return {
    envVar: JSON.stringify({ mcpServers }),
    fileContent: { mcpServers },
  };
}

/**
 * Write a temporary MCP config file for Copilot --additional-mcp-config.
 * Returns the path to the temp file.
 *
 * @param {string} rootDir
 * @param {Array<Object>} servers
 * @returns {string} — path to temp MCP config JSON
 */
export function writeTempCopilotMcpConfig(rootDir, servers) {
  const mcpConfig = buildCopilotMcpJson(servers);
  const dir = resolve(rootDir, ".bosun", ".tmp");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `mcp-config-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2), "utf8");
  return filePath;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
