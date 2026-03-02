/**
 * agent-tool-config.mjs — Per-Agent Tool Configuration Store
 *
 * Manages which tools and MCP servers are enabled for each agent profile.
 * Persisted as `.bosun/agent-tools.json` alongside the library manifest.
 *
 * Schema:
 *   {
 *     "agents": {
 *       "<agentId>": {
 *         "enabledTools": ["tool1", "tool2"] | null,   // null = all tools
 *         "enabledMcpServers": ["github", "context7"],  // enabled MCP server IDs
 *         "disabledBuiltinTools": ["tool3"],             // explicitly disabled builtins
 *         "updatedAt": "2026-01-01T00:00:00.000Z"
 *       }
 *     },
 *     "defaults": {
 *       "builtinTools": [...],          // default tool list for all agents
 *       "updatedAt": "..."
 *     }
 *   }
 *
 * EXPORTS:
 *   DEFAULT_BUILTIN_TOOLS         — list of default built-in tools for voice/agents
 *   loadToolConfig(rootDir)       — load the full config
 *   saveToolConfig(rootDir, cfg)  — save the full config
 *   getAgentToolConfig(rootDir, agentId) — get config for one agent
 *   setAgentToolConfig(rootDir, agentId, config) — update config for one agent
 *   getEffectiveTools(rootDir, agentId)  — compute final enabled tools list
 *   listAvailableTools(rootDir)   — list all available tools (builtin + MCP)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ── Constants ─────────────────────────────────────────────────────────────────

const TAG = "[agent-tool-config]";
const CONFIG_FILE = "agent-tools.json";

function getBosunHome() {
  return (
    process.env.BOSUN_HOME ||
    process.env.BOSUN_DIR ||
    resolve(homedir(), ".bosun")
  );
}

/**
 * Default built-in tools available to all voice agents and executors.
 * Maps to common capabilities that voice/agent sessions can invoke.
 */
export const DEFAULT_BUILTIN_TOOLS = Object.freeze([
  {
    id: "search-files",
    name: "Search Files",
    description: "Search for files in the workspace by name or pattern",
    category: "Built-In",
    icon: ":search:",
    default: true,
  },
  {
    id: "read-file",
    name: "Read File",
    description: "Read contents of a file in the workspace",
    category: "Built-In",
    icon: ":file:",
    default: true,
  },
  {
    id: "edit-file",
    name: "Edit File",
    description: "Create or edit files in the workspace",
    category: "Built-In",
    icon: ":edit:",
    default: true,
  },
  {
    id: "run-command",
    name: "Run Terminal Command",
    description: "Execute shell commands in a terminal",
    category: "Built-In",
    icon: ":terminal:",
    default: true,
  },
  {
    id: "web-search",
    name: "Web Search",
    description: "Search the web for information",
    category: "Built-In",
    icon: ":globe:",
    default: true,
  },
  {
    id: "code-search",
    name: "Semantic Code Search",
    description: "Search codebase semantically for relevant code",
    category: "Built-In",
    icon: ":cpu:",
    default: true,
  },
  {
    id: "git-operations",
    name: "Git Operations",
    description: "Run git commands (commit, push, branch, etc.)",
    category: "Built-In",
    icon: ":git:",
    default: true,
  },
  {
    id: "create-task",
    name: "Create Task",
    description: "Create new tasks and issues",
    category: "Built-In",
    icon: ":check:",
    default: true,
  },
  {
    id: "delegate-task",
    name: "Delegate to Agent",
    description: "Delegate work to another agent executor",
    category: "Built-In",
    icon: ":bot:",
    default: true,
  },
  {
    id: "fetch-url",
    name: "Fetch URL",
    description: "Fetch content from a URL and convert for LLM usage",
    category: "Built-In",
    icon: ":link:",
    default: true,
  },
  {
    id: "list-directory",
    name: "List Directory",
    description: "List contents of a directory in the workspace",
    category: "Built-In",
    icon: ":folder:",
    default: true,
  },
  {
    id: "grep-search",
    name: "Text Search (Grep)",
    description: "Search for exact text or regex patterns in files",
    category: "Built-In",
    icon: ":search:",
    default: true,
  },
  {
    id: "task-management",
    name: "Task Management",
    description: "Track and manage todo items and task status",
    category: "Built-In",
    icon: ":clipboard:",
    default: true,
  },
  {
    id: "notifications",
    name: "Send Notifications",
    description: "Send notifications via Telegram, webhook, etc.",
    category: "Built-In",
    icon: ":bell:",
    default: false,
  },
  {
    id: "vision-analysis",
    name: "Vision Analysis",
    description: "Analyze images and screenshots",
    category: "Built-In",
    icon: ":eye:",
    default: true,
  },
]);

// ── Config File I/O ───────────────────────────────────────────────────────────

function getConfigPath(rootDir) {
  return resolve(rootDir || getBosunHome(), ".bosun", CONFIG_FILE);
}

/**
 * Load the agent tool configuration.
 * @param {string} [rootDir]
 * @returns {{ agents: Object, defaults: Object }}
 */
export function loadToolConfig(rootDir) {
  const configPath = getConfigPath(rootDir);
  if (!existsSync(configPath)) {
    return {
      agents: {},
      defaults: {
        builtinTools: DEFAULT_BUILTIN_TOOLS.filter((t) => t.default).map((t) => t.id),
        updatedAt: new Date().toISOString(),
      },
    };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      agents: parsed.agents || {},
      defaults: parsed.defaults || {
        builtinTools: DEFAULT_BUILTIN_TOOLS.filter((t) => t.default).map((t) => t.id),
        updatedAt: new Date().toISOString(),
      },
    };
  } catch {
    return {
      agents: {},
      defaults: {
        builtinTools: DEFAULT_BUILTIN_TOOLS.filter((t) => t.default).map((t) => t.id),
        updatedAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * Save the full tool configuration.
 * @param {string} rootDir
 * @param {{ agents: Object, defaults: Object }} config
 */
export function saveToolConfig(rootDir, config) {
  const configPath = getConfigPath(rootDir);
  const dir = resolve(configPath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Get tool configuration for a specific agent.
 * @param {string} rootDir
 * @param {string} agentId
 * @returns {{ enabledTools: string[]|null, enabledMcpServers: string[], disabledBuiltinTools: string[] }}
 */
export function getAgentToolConfig(rootDir, agentId) {
  const config = loadToolConfig(rootDir);
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    return {
      enabledTools: null,
      enabledMcpServers: [],
      disabledBuiltinTools: [],
    };
  }
  return {
    enabledTools: agentConfig.enabledTools ?? null,
    enabledMcpServers: agentConfig.enabledMcpServers || [],
    disabledBuiltinTools: agentConfig.disabledBuiltinTools || [],
  };
}

/**
 * Update tool configuration for a specific agent.
 * @param {string} rootDir
 * @param {string} agentId
 * @param {{ enabledTools?: string[]|null, enabledMcpServers?: string[], disabledBuiltinTools?: string[] }} update
 * @returns {{ ok: boolean }}
 */
export function setAgentToolConfig(rootDir, agentId, update) {
  const config = loadToolConfig(rootDir);
  const existing = config.agents[agentId] || {};
  config.agents[agentId] = {
    ...existing,
    enabledTools: update.enabledTools !== undefined ? update.enabledTools : (existing.enabledTools ?? null),
    enabledMcpServers: update.enabledMcpServers !== undefined ? update.enabledMcpServers : (existing.enabledMcpServers || []),
    disabledBuiltinTools: update.disabledBuiltinTools !== undefined ? update.disabledBuiltinTools : (existing.disabledBuiltinTools || []),
    updatedAt: new Date().toISOString(),
  };
  saveToolConfig(rootDir, config);
  return { ok: true };
}

/**
 * Compute the effective enabled tools for an agent.
 * Merges builtin defaults with agent-specific overrides and MCP servers.
 *
 * @param {string} rootDir
 * @param {string} agentId
 * @returns {{ builtinTools: Array<{ id: string, name: string, enabled: boolean }>, mcpServers: string[] }}
 */
export function getEffectiveTools(rootDir, agentId) {
  const config = loadToolConfig(rootDir);
  const agentConfig = config.agents[agentId] || {};
  const disabledSet = new Set(agentConfig.disabledBuiltinTools || []);
  const defaultIds = new Set(config.defaults?.builtinTools || DEFAULT_BUILTIN_TOOLS.filter((t) => t.default).map((t) => t.id));

  const builtinTools = DEFAULT_BUILTIN_TOOLS.map((tool) => ({
    ...tool,
    enabled: !disabledSet.has(tool.id) && (agentConfig.enabledTools === null || agentConfig.enabledTools === undefined
      ? defaultIds.has(tool.id)
      : agentConfig.enabledTools.includes(tool.id)),
  }));

  return {
    builtinTools,
    mcpServers: agentConfig.enabledMcpServers || [],
  };
}

/**
 * List all available tools (builtin + installed MCP servers).
 * @param {string} rootDir
 * @returns {{ builtinTools: Array<Object>, mcpServers: Array<Object> }}
 */
export async function listAvailableTools(rootDir) {
  let mcpServers = [];
  try {
    const { listInstalledMcpServers } = await import("./mcp-registry.mjs");
    mcpServers = await listInstalledMcpServers(rootDir);
  } catch {
    // MCP registry not available
  }

  return {
    builtinTools: [...DEFAULT_BUILTIN_TOOLS],
    mcpServers: mcpServers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description || "",
      tags: s.tags || [],
      transport: s.meta?.transport || "stdio",
    })),
  };
}
