/**
 * primary-agent.mjs — Adapter that selects the primary agent implementation.
 *
 * Supports Codex SDK, Copilot SDK, and Claude SDK.
 * Includes timeout detection and automatic failover between adapters.
 */

import { loadConfig } from "../config/config.mjs";
import { ensureCodexConfig, printConfigSummary } from "../shell/codex-config.mjs";
import { ensureRepoConfigs, printRepoConfigSummary } from "../config/repo-config.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import { getAgentToolConfig, getEffectiveTools } from "./agent-tool-config.mjs";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { getEntry, getEntryContent, resolveAgentProfileLibraryMetadata } from "../infra/library-manager.mjs";
import { execPooledPrompt } from "./agent-pool.mjs";
import {
  execCodexPrompt,
  steerCodexPrompt,
  isCodexBusy,
  getThreadInfo,
  resetThread,
  initCodexShell,
  getActiveSessionId as getCodexSessionId,
  listSessions as listCodexSessions,
  switchSession as switchCodexSession,
  createSession as createCodexSession,
} from "../shell/codex-shell.mjs";
import {
  execCopilotPrompt,
  steerCopilotPrompt,
  isCopilotBusy,
  getSessionInfo as getCopilotSessionInfo,
  resetSession as resetCopilotSession,
  initCopilotShell,
} from "../shell/copilot-shell.mjs";
import {
  execClaudePrompt,
  steerClaudePrompt,
  isClaudeBusy,
  getSessionInfo as getClaudeSessionInfo,
  resetClaudeSession,
  initClaudeShell,
} from "../shell/claude-shell.mjs";
import {
  execOpencodePrompt,
  steerOpencodePrompt,
  isOpencodeBusy,
  getSessionInfo as getOpencodeSessionInfo,
  resetSession as resetOpencodeSession,
  initOpencodeShell,
  getActiveSessionId as getOpencodeSessionId,
  listSessions as listOpencodeSessions,
  switchSession as switchOpencodeSession,
  createSession as createOpencodeSession,
} from "../shell/opencode-shell.mjs";
import {
  execGeminiPrompt,
  steerGeminiPrompt,
  isGeminiBusy,
  getSessionInfo as getGeminiSessionInfo,
  resetSession as resetGeminiSession,
  initGeminiShell,
  getActiveSessionId as getGeminiSessionId,
  listSessions as listGeminiSessions,
  switchSession as switchGeminiSession,
  createSession as createGeminiSession,
} from "../shell/gemini-shell.mjs";
import { getModelsForExecutor, normalizeExecutorKey } from "../task/task-complexity.mjs";

/** Valid agent interaction modes */
const CORE_MODES = ["ask", "agent", "plan", "web", "instant"];
/** Custom modes loaded from library */
const _customModes = new Map();

const MODE_ALIASES = Object.freeze({
  code: "agent",
  implement: "agent",
  execute: "agent",
  architect: "plan",
  design: "plan",
  chat: "ask",
  question: "ask",
  fast: "instant",
  quick: "instant",
  browser: "web",
});

/** Current interaction mode — affects how prompts are framed */
let agentMode = "agent";

/**
 * Mode-specific prompt prefixes prepended to user messages.
 * - "ask"   → brief, direct answer without tool use
 * - "agent" → full agentic behavior (default, no prefix needed)
 * - "plan"  → create a plan but do not execute it
 * - "web"   → web-style direct answer, avoid file changes or heavy tooling
 * - "instant" → ultra-fast answer path for back-and-forth
 */
const MODE_PREFIXES = {
  ask: "[MODE: ask] Respond briefly and directly. Avoid using tools unless absolutely necessary. Do not make code changes.\n\n",
  agent: "",
  plan: "[MODE: plan] Create a detailed plan for the following request but do NOT execute it. Outline the steps, files involved, and approach without making any changes.\n\n",
  web: "[MODE: web] Respond in a concise, web-assistant style. Prioritize immediate answers and lightweight checks. Avoid code edits and long-running operations unless explicitly requested.\n\n",
  instant: "[MODE: instant] Respond immediately with the fastest useful answer. Keep it short, avoid deep tool use, and do not make code changes unless explicitly requested.\n\n",
};

const MODE_EXEC_POLICIES = Object.freeze({
  web: {
    timeoutMs: Number(process.env.PRIMARY_AGENT_WEB_TIMEOUT_MS) || 2 * 60 * 1000,
    maxFailoverAttempts: Number(process.env.PRIMARY_AGENT_WEB_FAILOVER_ATTEMPTS) || 0,
  },
  instant: {
    timeoutMs: Number(process.env.PRIMARY_AGENT_INSTANT_TIMEOUT_MS) || 90 * 1000,
    maxFailoverAttempts: Number(process.env.PRIMARY_AGENT_INSTANT_FAILOVER_ATTEMPTS) || 0,
  },
});

function normalizeAgentMode(rawMode, fallback = "agent") {
  const normalized = String(rawMode || "").trim().toLowerCase();
  if (!normalized) return fallback;
  const mapped = MODE_ALIASES[normalized] || normalized;
  return getValidModes().includes(mapped) ? mapped : fallback;
}

/**
 * Get all valid modes including dynamically registered custom modes.
 * @returns {string[]}
 */
function getValidModes() {
  return [...CORE_MODES, ..._customModes.keys()];
}

/**
 * Get mode prefix for a given mode, including custom modes.
 * @param {string} mode
 * @returns {string}
 */
function getModePrefix(mode) {
  if (MODE_PREFIXES[mode] !== undefined) return MODE_PREFIXES[mode];
  const custom = _customModes.get(mode);
  return custom?.prefix || "";
}

/**
 * Get execution policy for a given mode, including custom modes.
 * @param {string} mode
 * @returns {object|null}
 */
function getModeExecPolicy(mode) {
  if (MODE_EXEC_POLICIES[mode]) return MODE_EXEC_POLICIES[mode];
  const custom = _customModes.get(mode);
  return custom?.execPolicy || null;
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(Boolean);
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const value = Number(bytes);
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const size = value / Math.pow(1024, idx);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[idx]}`;
}

function formatAttachmentLine(attachment) {
  const name = attachment.name || attachment.filename || attachment.title || "attachment";
  const kind = attachment.kind ? ` (${attachment.kind})` : "";
  const sizeText = attachment.size ? `, ${formatBytes(attachment.size)}` : "";
  const location =
    attachment.filePath ||
    attachment.path ||
    attachment.url ||
    attachment.uri ||
    "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${sizeText}${suffix}`;
}

function appendAttachmentsToPrompt(message, attachments) {
  const list = normalizeAttachments(attachments);
  if (!list.length) return { message, appended: false };
  const lines = ["", "Attachments:", ...list.map(formatAttachmentLine)];
  return { message: `${message}${lines.join("\n")}`, appended: true };
}

function normalizeRepoMap(repoMap) {
  if (!repoMap || typeof repoMap !== "object") return null;
  const root = String(repoMap.root || repoMap.repoRoot || "").trim();
  const files = Array.isArray(repoMap.files)
    ? repoMap.files
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          path: String(entry.path || entry.file || "").trim(),
          summary: String(entry.summary || entry.description || "").trim(),
          symbols: Array.isArray(entry.symbols)
            ? entry.symbols.map((symbol) => String(symbol || "").trim()).filter(Boolean)
            : [],
        }))
        .filter((entry) => entry.path)
    : [];
  if (!root && files.length === 0) return null;
  return { root, files };
}

function formatRepoMap(repoMap) {
  const normalized = normalizeRepoMap(repoMap);
  if (!normalized) return "";
  const lines = ["## Repo Map"];
  if (normalized.root) lines.push(`- Root: ${normalized.root}`);
  for (const file of normalized.files) {
    const parts = [file.path];
    if (file.symbols.length) parts.push(`symbols: ${file.symbols.join(", ")}`);
    if (file.summary) parts.push(file.summary);
    lines.push(`- ${parts.join(" — ")}`);
  }
  return lines.join("\n");
}

function summarizePathSegment(segment) {
  return String(segment || "")
    .replace(/[-_]+/g, " ")
    .replace(/\.m?js$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferRepoMapEntry(pathValue) {
  const path = String(pathValue || "").trim().replace(/\\/g, "/");
  if (!path) return null;
  const name = path.split("/").pop() || path;
  const stem = summarizePathSegment(name);
  const dir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
  const dirHint = dir ? summarizePathSegment(dir.split("/").pop()) : "";
  const symbols = [];
  const lowerStem = stem.toLowerCase();
  if (lowerStem) {
    const compact = lowerStem
      .split(" ")
      .filter(Boolean)
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("");
    if (compact) {
      symbols.push(compact);
      if (!compact.startsWith("test")) symbols.push(`test${compact.charAt(0).toUpperCase()}${compact.slice(1)}`);
    }
  }
  const summaryParts = [];
  if (dirHint) summaryParts.push(`${dirHint} module`);
  if (stem) summaryParts.push(stem);
  return {
    path,
    summary: summaryParts.join(" — "),
    symbols: [...new Set(symbols)].slice(0, 3),
  };
}

function deriveRepoMap(options = {}) {
  const explicit = normalizeRepoMap(options.repoMap);
  if (explicit) return explicit;
  const changedFiles = Array.isArray(options.changedFiles)
    ? options.changedFiles.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!changedFiles.length) return null;
  const root = String(options.repoRoot || options.cwd || resolveRepoRoot() || "").trim();
  const files = changedFiles
    .map((pathValue) => inferRepoMapEntry(pathValue))
    .filter(Boolean)
    .slice(0, Number(options.repoMapFileLimit) > 0 ? Number(options.repoMapFileLimit) : 12);
  if (!root && files.length === 0) return null;
  return { root, files };
}

function inferExecutionRole(options = {}, effectiveMode = "agent") {
  const explicitRole = String(options.executionRole || "").trim().toLowerCase();
  if (explicitRole) return explicitRole;
  if (effectiveMode === "plan") return "architect";
  const architectPlan = String(options.architectPlan || options.planSummary || "").trim();
  if (architectPlan) return "editor";
  return "";
}
function buildArchitectEditorFrame(options = {}, effectiveMode = "agent") {
  const executionRole = inferExecutionRole(options, effectiveMode);
  const repoMapBlock = formatRepoMap(deriveRepoMap(options));
  const architectPlan = String(options.architectPlan || options.planSummary || "").trim();
  const lines = ["## Architect/Editor Execution"];

  if (executionRole === "architect") {
    lines.push(
      "You are the architect phase.",
      "Do not implement code changes in this phase.",
      "Use the repo map to produce a compact structural plan that an editor can execute and validate.",
      "Editor handoff: include ordered implementation steps, touched files, risks, and validation guidance.",
    );
  } else if (executionRole === "editor") {
    lines.push(
      "You are the editor phase.",
      "Implement the approved plan with focused edits and verification.",
      "Prefer the supplied repo map over broad rediscovery unless validation reveals drift.",
    );
    if (architectPlan) {
      lines.push("", "## Architect Plan", architectPlan);
    }
  } else {
    return repoMapBlock;
  }

  if (repoMapBlock) {
    lines.push("", repoMapBlock);
  }

  return lines.join("\n");
}

function summarizeContextCompressionItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const counts = {
    agent: 0,
    user: 0,
    tool: 0,
    other: 0,
  };

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const compressedTag = String(item._compressed || "").trim().toLowerCase();
    const text = String(item.text || item.output || item.aggregated_output || "").toLowerCase();
    const hasToolPlaceholder =
      Boolean(item._cachedLogId)
      || text.includes("full output: bosun --tool-log")
      || text.includes(" chars compressed");

    if (compressedTag.startsWith("agent_")) {
      counts.agent += 1;
      continue;
    }
    if (compressedTag === "user_breadcrumb") {
      counts.user += 1;
      continue;
    }
    if (hasToolPlaceholder) {
      counts.tool += 1;
      continue;
    }
    if (compressedTag) counts.other += 1;
  }

  const total = counts.agent + counts.user + counts.tool + counts.other;
  if (total === 0) return null;

  const detailParts = [];
  if (counts.agent) detailParts.push(`${counts.agent} agent message${counts.agent === 1 ? "" : "s"}`);
  if (counts.user) detailParts.push(`${counts.user} user prompt${counts.user === 1 ? "" : "s"}`);
  if (counts.tool) detailParts.push(`${counts.tool} tool output${counts.tool === 1 ? "" : "s"}`);
  if (counts.other) detailParts.push(`${counts.other} other item${counts.other === 1 ? "" : "s"}`);

  return {
    total,
    counts,
    detail: detailParts.join(", "),
    content:
      `Context summarized for continuation: ${total} older item${total === 1 ? "" : "s"} compressed (${detailParts.join(", ")}). ` +
      `Session history in this view is unchanged.`,
  };
}

function buildPrimaryToolCapabilityContract(options = {}) {
  let rootDir = "";
  try {
    rootDir = String(options.cwd || resolveRepoRoot() || process.cwd()).trim();
  } catch {
    rootDir = String(options.cwd || process.cwd()).trim();
  }
  const agentProfileId = String(options.agentProfileId || "").trim();
  const toolState = agentProfileId
    ? getEffectiveTools(rootDir, agentProfileId)
    : getEffectiveTools(rootDir, "__default__");
  const rawCfg = agentProfileId ? getAgentToolConfig(rootDir, agentProfileId) : null;
  const enabledBuiltinTools = (Array.isArray(toolState?.builtinTools) ? toolState.builtinTools : [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      id: String(tool?.id || "").trim(),
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || "").trim(),
    }))
    .filter((tool) => tool.id);
  const enabledMcpServers = Array.isArray(rawCfg?.enabledMcpServers)
    ? rawCfg.enabledMcpServers.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const manifest = {
    agentProfileId: agentProfileId || null,
    enabledBuiltinTools,
    enabledMcpServers,
    toolBridge: {
      module: "./voice-tools.mjs",
      function: "executeToolCall(toolName, args, context)",
      quickUse: [
        "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('get_workspace_context', {}, {});console.log(r?.result||r);})\"",
        "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('list_tasks', {limit:10}, {});console.log(r?.result||r);})\"",
      ],
    },
  };
  return [
    "## Tool Capability Contract",
    "Use enabled tools by default. Do not claim tools are unavailable without first trying them.",
    "Enabled tools JSON:",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "When uncertain about tool inputs/outputs, call get_admin_help via executeToolCall first.",
  ].join("\n");
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function resolveSelectedAgentProfileContext(rootDir, agentProfileId) {
  const id = String(agentProfileId || "").trim();
  if (!id) return null;
  const entry = getEntry(rootDir, id);
  if (!entry || entry.type !== "agent") return null;
  const profile = getEntryContent(rootDir, entry);
  if (!profile || typeof profile !== "object") return null;

  const metadata = resolveAgentProfileLibraryMetadata(entry, profile);
  const promptEntry = profile?.promptOverride ? getEntry(rootDir, profile.promptOverride) : null;
  const promptContent = promptEntry ? getEntryContent(rootDir, promptEntry) : null;
  const skills = toStringArray(profile?.skills)
    .map((skillId) => {
      const skillEntry = getEntry(rootDir, skillId);
      if (!skillEntry || skillEntry.type !== "skill") return null;
      return {
        id: skillEntry.id,
        name: skillEntry.name || skillEntry.id,
        content: String(getEntryContent(rootDir, skillEntry) || "").trim(),
      };
    })
    .filter(Boolean);

  return {
    id: entry.id,
    name: entry.name || entry.id,
    description: entry.description || "",
    profile,
    metadata,
    promptOverride: promptEntry
      ? {
        id: promptEntry.id,
        name: promptEntry.name || promptEntry.id,
        content: typeof promptContent === "string"
          ? promptContent.trim()
          : String(promptContent || "").trim(),
      }
      : null,
    skills,
  };
}

function buildPrimaryAgentProfileContract(options = {}) {
  let rootDir = "";
  try {
    rootDir = String(options.cwd || resolveRepoRoot() || process.cwd()).trim();
  } catch {
    rootDir = String(options.cwd || process.cwd()).trim();
  }
  const selected = resolveSelectedAgentProfileContext(rootDir, options.agentProfileId);
  if (!selected) return { block: "", preferredMode: "", preferredModel: "" };

  const profileInstructions = String(
    selected.profile?.instructions
      || selected.profile?.manualInstructions
      || selected.profile?.voiceInstructions
      || "",
  ).trim();
  const summary = {
    id: selected.id,
    name: selected.name,
    description: selected.description,
    agentCategory: selected.metadata.agentCategory,
    interactiveMode: selected.metadata.interactiveMode,
    interactiveLabel: selected.metadata.interactiveLabel,
    sdk: String(selected.profile?.sdk || "").trim() || null,
    model: String(selected.profile?.model || "").trim() || null,
    showInChatDropdown: selected.metadata.showInChatDropdown,
    skillIds: selected.skills.map((skill) => skill.id),
  };
  const lines = [
    "## Selected Agent Profile",
    "Apply this profile consistently unless the user explicitly overrides it.",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
  ];
  if (profileInstructions) {
    lines.push("## Profile Instructions", profileInstructions);
  }
  if (selected.promptOverride?.content) {
    lines.push(`## Prompt Override: ${selected.promptOverride.name}`, selected.promptOverride.content);
  }
  if (selected.skills.length > 0) {
    lines.push("## Profile Skills");
    for (const skill of selected.skills) {
      if (!skill.content) continue;
      lines.push(`### ${skill.name}`, skill.content);
    }
  }
  return {
    block: lines.join("\n\n"),
    preferredMode: String(selected.metadata.interactiveMode || "").trim(),
    preferredModel: String(selected.profile?.model || "").trim(),
  };
}

const ADAPTERS = {
  "codex-sdk": {
    name: "codex-sdk",
    provider: "CODEX",
    displayName: "Codex",
    exec: (msg, opts) => execCodexPrompt(msg, { persistent: true, ...opts }),
    steer: steerCodexPrompt,
    isBusy: isCodexBusy,
    getInfo: () => {
      const info = getThreadInfo();
      return { ...info, sessionId: info.sessionId || info.threadId };
    },
    reset: resetThread,
    init: async () => {
      await initCodexShell();
      return true;
    },
    getSessionId: getCodexSessionId,
    listSessions: listCodexSessions,
    switchSession: switchCodexSession,
    createSession: createCodexSession,
    sdkCommands: ["/compact", "/status", "/context", "/mcp", "/model", "/clear"],
    /**
     * Forward an SDK-native command to the Codex shell.
     * /clear is handled specially as a reset; others are sent as user input.
     */
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetThread();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execCodexPrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "copilot-sdk": {
    name: "copilot-sdk",
    provider: "COPILOT",
    displayName: "Copilot",
    exec: (msg, opts) => execCopilotPrompt(msg, { persistent: true, ...opts }),
    steer: steerCopilotPrompt,
    isBusy: isCopilotBusy,
    getInfo: () => getCopilotSessionInfo(),
    reset: resetCopilotSession,
    init: async () => initCopilotShell(),
    sdkCommands: ["/status", "/model", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetCopilotSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execCopilotPrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "claude-sdk": {
    name: "claude-sdk",
    provider: "CLAUDE",
    displayName: "Claude",
    exec: execClaudePrompt,
    steer: steerClaudePrompt,
    isBusy: isClaudeBusy,
    getInfo: () => getClaudeSessionInfo(),
    reset: resetClaudeSession,
    init: async () => {
      await initClaudeShell();
      return true;
    },
    sdkCommands: ["/compact", "/status", "/model", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetClaudeSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execClaudePrompt(fullCmd, {
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "gemini-sdk": {
    name: "gemini-sdk",
    provider: "GEMINI",
    displayName: "Gemini",
    exec: (msg, opts) => execGeminiPrompt(msg, { persistent: true, ...opts }),
    steer: steerGeminiPrompt,
    isBusy: isGeminiBusy,
    getInfo: () => getGeminiSessionInfo(),
    reset: resetGeminiSession,
    init: async () => initGeminiShell(),
    getSessionId: getGeminiSessionId,
    listSessions: listGeminiSessions,
    switchSession: switchGeminiSession,
    createSession: createGeminiSession,
    sdkCommands: ["/status", "/model", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetGeminiSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execGeminiPrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
  "opencode-sdk": {
    name: "opencode-sdk",
    provider: "OPENCODE",
    displayName: "OpenCode",
    exec: (msg, opts) => execOpencodePrompt(msg, { persistent: true, ...opts }),
    steer: steerOpencodePrompt,
    isBusy: isOpencodeBusy,
    getInfo: () => getOpencodeSessionInfo(),
    reset: resetOpencodeSession,
    init: async () => {
      await initOpencodeShell();
      return true;
    },
    getSessionId: getOpencodeSessionId,
    listSessions: listOpencodeSessions,
    switchSession: switchOpencodeSession,
    createSession: createOpencodeSession,
    sdkCommands: ["/status", "/model", "/sessions", "/clear"],
    execSdkCommand: async (command, args, options = {}) => {
      const cmd = command.startsWith("/") ? command : `/${command}`;
      if (cmd === "/clear") {
        await resetOpencodeSession();
        return "Session cleared.";
      }
      const fullCmd = args ? `${cmd} ${args}` : cmd;
      return execOpencodePrompt(fullCmd, {
        persistent: true,
        cwd: options.cwd,
        sessionId: options.sessionId || null,
      });
    },
  },
};

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

let activeAdapter = ADAPTERS["codex-sdk"];
let activeExecutorSelection = "codex-sdk";
let primaryProfile = null;
let primaryFallbackReason = null;
let initialized = false;

const CONFIG_WARNING_THROTTLE_MS = 5 * 60 * 1000;
const _configWarningCache = new Map();

function warnConfigIssueThrottled(key, message) {
  const now = Date.now();
  const prev = _configWarningCache.get(key) || 0;
  if (now - prev < CONFIG_WARNING_THROTTLE_MS) {
    return;
  }
  _configWarningCache.set(key, now);
  console.warn(message);
}

function normalizePrimarySdkName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-sdk$/, "");
}

function ensurePrimaryAgentConfigs(primaryName) {
  const primarySdk = normalizePrimarySdkName(primaryName) || "codex";
  const allowRuntimeCodexMutation = envFlagEnabled(
    process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION,
  );
  const vkBaseUrl = String(
    process.env.VK_BASE_URL ||
      `http://127.0.0.1:${process.env.VK_RECOVERY_PORT || "54089"}`,
  ).trim();
  const vkSelected =
    String(process.env.KANBAN_BACKEND || "").trim().toLowerCase() === "vk" ||
    ["vk", "hybrid"].includes(
      String(process.env.EXECUTOR_MODE || "").trim().toLowerCase(),
    );
  const includeWorkspaceVkMcp = vkSelected && vkBaseUrl.length > 0;
  let repoRoot = "";
  try {
    repoRoot = resolveRepoRoot();
  } catch {
    repoRoot = "";
  }

  if (repoRoot) {
    if (!process.env.REPO_ROOT) process.env.REPO_ROOT = repoRoot;
    if (!process.env.BOSUN_AGENT_REPO_ROOT) {
      process.env.BOSUN_AGENT_REPO_ROOT = repoRoot;
    }
    try {
      const repoResult = ensureRepoConfigs(repoRoot, {
        primarySdk,
        vkBaseUrl,
        skipVk: !includeWorkspaceVkMcp,
      });
      const logLines = [];
      printRepoConfigSummary(repoResult, (msg) => logLines.push(msg));
      if (logLines.some((line) => line.includes("created") || line.includes("updated"))) {
        console.log("[primary-agent] Repo config refresh:");
        for (const line of logLines) console.log(`[primary-agent] ${line}`);
      }
    } catch (err) {
      warnConfigIssueThrottled(
        `repo-config:${repoRoot}`,
        `[primary-agent] failed to ensure repo config for ${repoRoot}: ${err?.message || err}`,
      );
    }
  }

  try {
    const codexResult = ensureCodexConfig({
      env: process.env,
      primarySdk,
      skipVk: true,
      dryRun: !allowRuntimeCodexMutation,
    });
    if (!codexResult?.noChanges) {
      if (!allowRuntimeCodexMutation) {
        console.log(
          "[primary-agent] Codex config drift detected (runtime is read-only; run `node cli.mjs --setup` to apply).",
        );
      } else {
        console.log("[primary-agent] Codex config refresh:");
      }
      printConfigSummary(codexResult, (msg) => console.log(`[primary-agent] ${msg}`));
    }
  } catch (err) {
    warnConfigIssueThrottled(
      "codex-config",
      `[primary-agent] failed to ensure Codex config: ${err?.message || err}`,
    );
  }
}

function normalizePrimaryAgent(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "codex-sdk";
  if (["codex", "codex-sdk"].includes(raw)) return "codex-sdk";
  if (["copilot", "copilot-sdk", "github-copilot"].includes(raw))
    return "copilot-sdk";
  if (["claude", "claude-sdk", "claude_code", "claude-code"].includes(raw))
    return "claude-sdk";
  if (["gemini", "gemini-sdk", "google-gemini"].includes(raw))
    return "gemini-sdk";
  if (["opencode", "opencode-sdk", "open-code"].includes(raw))
    return "opencode-sdk";
  return raw;
}

function selectPrimaryExecutor(config) {
  const executors = config?.executorConfig?.executors || [];
  if (!executors.length) return null;
  const primary = executors.find(
    (e) => (e.role || "").toLowerCase() === "primary",
  );
  return primary || executors[0];
}

function executorToAdapter(executor) {
  const key = normalizeExecutorKey(executor);
  if (key === "copilot") return "copilot-sdk";
  if (key === "claude") return "claude-sdk";
  if (key === "gemini") return "gemini-sdk";
  if (key === "opencode") return "opencode-sdk";
  return "codex-sdk";
}

function readAdapterBusy(adapter) {
  try {
    return adapter.isBusy();
  } catch {
    return false;
  }
}

function getAdapterCapabilities(adapter) {
  return {
    sessions: typeof adapter.listSessions === "function",
    steering: typeof adapter.steer === "function",
    sdkCommands: adapter.sdkCommands || [],
  };
}

function resolveAgentSelection(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const normalized = normalizePrimaryAgent(raw);
  if (ADAPTERS[normalized]) {
    return { adapterName: normalized, selectionId: normalized };
  }

  const configured = getAvailableAgents();
  const match = configured.find((agent) => agent.id === raw);
  if (!match) return null;
  const adapterName = normalizePrimaryAgent(
    match.adapterId || executorToAdapter(match.executor || match.provider),
  );
  if (!ADAPTERS[adapterName]) return null;
  return { adapterName, selectionId: match.id };
}

function resolvePrimaryAgent(nameOrConfig) {
  if (typeof nameOrConfig === "string" && nameOrConfig.trim()) {
    return normalizePrimaryAgent(nameOrConfig);
  }
  if (nameOrConfig && typeof nameOrConfig === "object") {
    const direct = normalizePrimaryAgent(nameOrConfig.primaryAgent);
    if (direct) return direct;
  }
  if (process.env.PRIMARY_AGENT || process.env.PRIMARY_AGENT_SDK) {
    return normalizePrimaryAgent(
      process.env.PRIMARY_AGENT || process.env.PRIMARY_AGENT_SDK,
    );
  }
  const cfg = loadConfig();
  const direct = normalizePrimaryAgent(cfg?.primaryAgent || "");
  if (direct) return direct;
  primaryProfile = selectPrimaryExecutor(cfg);
  const mapped = executorToAdapter(primaryProfile?.executor);
  return mapped || "codex-sdk";
}

export function setPrimaryAgent(name) {
  const resolved = resolveAgentSelection(name);
  if (resolved) {
    activeAdapter = ADAPTERS[resolved.adapterName] || ADAPTERS["codex-sdk"];
    activeExecutorSelection =
      resolved.selectionId || activeAdapter.name || "codex-sdk";
    return activeAdapter.name;
  }

  const normalized = normalizePrimaryAgent(name);
  const adapterName = ADAPTERS[normalized] ? normalized : "codex-sdk";
  activeAdapter = ADAPTERS[adapterName] || ADAPTERS["codex-sdk"];
  activeExecutorSelection = adapterName;
  return activeAdapter.name;
}

export function getPrimaryAgentName() {
  return activeAdapter?.name || "codex-sdk";
}

export function getPrimaryAgentSelection() {
  return activeExecutorSelection || getPrimaryAgentName();
}

export async function switchPrimaryAgent(name) {
  const target = resolveAgentSelection(name);
  if (!target) {
    return { ok: false, reason: "unknown_agent" };
  }
  activeAdapter = ADAPTERS[target.adapterName];
  activeExecutorSelection = target.selectionId || target.adapterName;
  primaryFallbackReason = null;
  initialized = false;
  try {
    await initPrimaryAgent(target.selectionId || target.adapterName);
    return { ok: true, name: getPrimaryAgentName() };
  } catch (err) {
    return { ok: false, reason: err?.message || "init_failed" };
  }
}

export async function initPrimaryAgent(nameOrConfig = null) {
  if (initialized) return getPrimaryAgentName();
  const desired = resolvePrimaryAgent(nameOrConfig);
  setPrimaryAgent(desired);
  if (
    primaryProfile?.name &&
    (activeExecutorSelection === activeAdapter.name || !activeExecutorSelection)
  ) {
    activeExecutorSelection = String(primaryProfile.name).trim() || activeAdapter.name;
  }

  if (
    activeAdapter.name === "codex-sdk" &&
    envFlagEnabled(process.env.CODEX_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Codex SDK disabled — attempting fallback";
    if (!envFlagEnabled(process.env.COPILOT_SDK_DISABLED)) {
      setPrimaryAgent("copilot-sdk");
    } else if (!envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)) {
      setPrimaryAgent("claude-sdk");
    } else if (!envFlagEnabled(process.env.GEMINI_SDK_DISABLED)) {
      setPrimaryAgent("gemini-sdk");
    } else if (!envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)) {
      setPrimaryAgent("opencode-sdk");
    }
  }

  if (
    activeAdapter.name === "claude-sdk" &&
    envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Claude SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  if (
    activeAdapter.name === "gemini-sdk" &&
    envFlagEnabled(process.env.GEMINI_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Gemini SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  if (
    activeAdapter.name === "opencode-sdk" &&
    envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "OpenCode SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  ensurePrimaryAgentConfigs(activeAdapter.name);

  const ok = await activeAdapter.init();
  if (activeAdapter.name === "copilot-sdk" && ok === false) {
    primaryFallbackReason = "Copilot SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }
  if (activeAdapter.name === "gemini-sdk" && ok === false) {
    primaryFallbackReason = "Gemini SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }
  if (activeAdapter.name === "opencode-sdk" && ok === false) {
    primaryFallbackReason = "OpenCode SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }

  initialized = true;
  return getPrimaryAgentName();
}

/** Default timeout for primary agent execution (45 minutes — agents may work for extended periods) */
const PRIMARY_EXEC_TIMEOUT_MS = Number(process.env.PRIMARY_AGENT_TIMEOUT_MS) || 45 * 60 * 1000;

/** Maximum number of failover attempts across adapters */
const MAX_FAILOVER_ATTEMPTS = 2;

/** Ordered fallback chain — if the current adapter times out, try the next */
const FALLBACK_ORDER = [
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
];

const FAILOVER_CONSECUTIVE_INFRA_ERRORS = Math.max(
  1,
  Number(process.env.PRIMARY_AGENT_FAILOVER_CONSECUTIVE_INFRA_ERRORS) || 3,
);
const FAILOVER_ERROR_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.PRIMARY_AGENT_FAILOVER_ERROR_WINDOW_MS) ||
    10 * 60 * 1000,
);
const _primaryRecoveryRetryEnv = Number(
  process.env.PRIMARY_AGENT_RECOVERY_RETRY_ATTEMPTS,
);
const PRIMARY_RECOVERY_RETRY_ATTEMPTS = Number.isFinite(
  _primaryRecoveryRetryEnv,
)
  ? Math.max(0, _primaryRecoveryRetryEnv)
  : 1;

const _adapterFailureState = new Map();

function adapterErrorText(err) {
  const message = String(err?.message || err || "");
  const code = String(err?.code || "");
  return `${code} ${message}`.trim();
}

function isSessionScopedAdapterError(err) {
  const text = adapterErrorText(err).toLowerCase();
  if (!text) return false;
  return (
    /\b(session|thread|conversation|context)\b.*\b(not found|expired|invalid|closed|corrupt)\b/.test(
      text,
    ) ||
    /\bfailed to resume session\b/.test(text) ||
    /\bsession does not exist\b/.test(text)
  );
}

function isInfrastructureAdapterError(err) {
  const text = adapterErrorText(err).toLowerCase();
  if (!text) return false;
  return (
    /\bagent_timeout\b/.test(text) ||
    /\bcodex exec exited with code\b/.test(text) ||
    /\btransport channel closed\b/.test(text) ||
    /\bstream disconnected\b/.test(text) ||
    /\brate limit|too many requests|429\b/.test(text) ||
    /\bservice unavailable|temporarily unavailable|overloaded\b/.test(text) ||
    /\bcannot find module\b/.test(text) ||
    /\bsdk not available|failed to load sdk\b/.test(text) ||
    /\beconnreset|econnrefused|etimedout|network error\b/.test(text) ||
    /\bsegfault|crash|killed\b/.test(text)
  );
}

function clearAdapterFailureState(adapterName) {
  if (!adapterName) return;
  _adapterFailureState.delete(adapterName);
}

function noteAdapterFailure(adapterName, err) {
  const now = Date.now();
  const infrastructure = isInfrastructureAdapterError(err);
  const previous = _adapterFailureState.get(adapterName) || {
    streak: 0,
    lastAt: 0,
    lastError: "",
    infrastructure: false,
  };

  const next = {
    streak: 0,
    lastAt: now,
    lastError: adapterErrorText(err),
    infrastructure,
  };

  if (infrastructure) {
    const withinWindow =
      now - Number(previous.lastAt || 0) <= FAILOVER_ERROR_WINDOW_MS;
    next.streak =
      withinWindow && previous.infrastructure ? previous.streak + 1 : 1;
  }

  _adapterFailureState.set(adapterName, next);
  return {
    ...next,
    allowFailover:
      infrastructure && next.streak >= FAILOVER_CONSECUTIVE_INFRA_ERRORS,
  };
}

async function recoverAdapterSession(adapter, adapterName) {
  if (!adapter) return;
  if (typeof adapter.reset === "function") {
    try {
      await adapter.reset();
    } catch (err) {
      console.warn(
        `[primary-agent] recovery reset failed for ${adapterName}: ${err?.message || err}`,
      );
    }
  }
  if (typeof adapter.init === "function") {
    await adapter.init();
  }
}

function mapAdapterToPoolSdk(adapterName) {
  const normalized = String(adapterName || "").trim().toLowerCase();
  if (normalized === "copilot-sdk") return "copilot";
  if (normalized === "claude-sdk") return "claude";
  return "codex";
}

function shouldUseIsolatedPoolExecution(adapter, options = {}) {
  if (options.forceIsolated === true) return true;
  if (options.allowConcurrent === false) return false;
  if (!adapter || typeof adapter.isBusy !== "function") return false;
  if (!adapter.isBusy()) return false;

  const requestedSessionId = options.sessionId
    ? String(options.sessionId)
    : "";
  let activeSessionId = "";
  try {
    const info = adapter.getInfo ? adapter.getInfo() : null;
    activeSessionId = String(info?.sessionId || info?.threadId || "");
  } catch {
    activeSessionId = "";
  }

  if (!requestedSessionId || !activeSessionId) return true;
  return requestedSessionId !== activeSessionId;
}

/**
 * Wrap a promise with a timeout. Rejects with a clear error when exceeded.
 * If an AbortController is provided, it will be signalled on timeout so the
 * underlying agent session can clean up (reset activeTurn, unsubscribe, etc.).
 */
function withTimeout(promise, ms, label = "operation", abortController = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortController && !abortController.signal.aborted) {
        try { abortController.abort("timeout"); } catch { /* best effort */ }
      }
      reject(new Error(`AGENT_TIMEOUT: ${label} did not respond within ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function execPrimaryPrompt(userMessage, options = {}) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  const selectedProfile = buildPrimaryAgentProfileContract(options);
  const sessionId =
    (options && options.sessionId ? String(options.sessionId) : "") ||
    `primary-${activeAdapter.name}`;
  const sessionType =
    (options && options.sessionType ? String(options.sessionType) : "") ||
    "primary";
  const effectiveMode = normalizeAgentMode(
    options.mode || selectedProfile.preferredMode || agentMode,
    agentMode,
  );
  const effectiveModel = options.model || selectedProfile.preferredModel || undefined;
  const modePolicy = getModeExecPolicy(effectiveMode);
  const timeoutMs = options.timeoutMs || modePolicy?.timeoutMs || PRIMARY_EXEC_TIMEOUT_MS;
  const maxFailoverAttempts = Number.isInteger(options.maxFailoverAttempts)
    ? Math.max(0, Number(options.maxFailoverAttempts))
    : modePolicy?.maxFailoverAttempts ?? MAX_FAILOVER_ATTEMPTS;
  const tracker = getSessionTracker();
  const attachments = normalizeAttachments(options.attachments);
  const attachmentsAppended = options.attachmentsAppended === true;

  // Apply mode prefix (options.mode overrides the global setting for this call)
  const modePrefix = getModePrefix(effectiveMode);
  const messageWithAttachments = attachments.length && !attachmentsAppended
    ? appendAttachmentsToPrompt(userMessage, attachments).message
    : userMessage;
  const toolContract = buildPrimaryToolCapabilityContract(options);
  const messageWithToolContract = [selectedProfile.block, toolContract, messageWithAttachments]
    options,
  // Record user message (original, without mode prefix)
  tracker.recordEvent(sessionId, {
    role: "user",
    content: userMessage,
    attachments: attachments.length ? attachments : undefined,
    timestamp: new Date().toISOString(),
    _sessionType: sessionType,
    _mode: effectiveMode,
  });

  if (shouldUseIsolatedPoolExecution(activeAdapter, options)) {
    const pooled = await execPooledPrompt(framedMessage, {
      timeoutMs,
      onEvent: options.onEvent,
      abortController: options.abortController,
      cwd: options.cwd,
      model: effectiveModel,
      sdk: mapAdapterToPoolSdk(activeAdapter.name),
      sessionType,
    });
    const pooledText =
      typeof pooled === "string"
        ? pooled
        : pooled?.finalResponse || pooled?.text || pooled?.message || JSON.stringify(pooled);
    tracker.recordEvent(sessionId, {
      role: "assistant",
      content: pooledText,
      timestamp: new Date().toISOString(),
      _sessionType: sessionType,
    });
    const compressionSummary = summarizeContextCompressionItems(pooled?.items);
    if (compressionSummary) {
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "system",
        content: compressionSummary.content,
        timestamp: new Date().toISOString(),
        meta: {
          contextCompression: compressionSummary,
        },
      });
    }
    return pooled;
  }

  // Build ordered list of adapters to try: current first, then fallbacks
  const adaptersToTry = [activeAdapter.name];
  for (const name of FALLBACK_ORDER) {
    if (name !== activeAdapter.name && ADAPTERS[name]) {
      const envDisabledKey = `${name.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
      if (!envFlagEnabled(process.env[envDisabledKey])) {
        adaptersToTry.push(name);
      }
    }
  }

  let lastError = null;
  const maxAdaptersToTry = Math.min(
    adaptersToTry.length,
    maxFailoverAttempts + 1,
  );

  for (let attempt = 0; attempt < maxAdaptersToTry; attempt++) {
    const adapterName = adaptersToTry[attempt];
    const adapter = ADAPTERS[adapterName];
    if (!adapter) continue;

    // If failing over to a different adapter, switch and init
    if (attempt > 0) {
      console.warn(
        `[primary-agent] :alert: Failing over from ${adaptersToTry[attempt - 1]} to ${adapterName} (reason: ${lastError?.message || "unknown"})`,
      );
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "failover",
        content: `:alert: Agent "${adaptersToTry[attempt - 1]}" failed — switching to "${adapterName}": ${lastError?.message || "timeout/error"}`,
        timestamp: new Date().toISOString(),
      });
      setPrimaryAgent(adapterName);
      primaryFallbackReason = `Failover from ${adaptersToTry[attempt - 1]}: ${lastError?.message || "timeout"}`;
      try {
        await adapter.init();
      } catch (initErr) {
        console.error(`[primary-agent] Failed to init ${adapterName}:`, initErr.message);
        lastError = initErr;
        continue;
      }
    }

    try {
      // Create an AbortController so withTimeout can signal the adapter to
      // cancel its in-flight work (reset activeTurn, unsubscribe events, etc.).
      // If the caller already provided an AbortController, forward its abort
      // to our timeout controller so both caller-initiated and timeout aborts work.
      const timeoutAbort = new AbortController();
      if (options.abortController?.signal) {
        const callerSignal = options.abortController.signal;
        if (callerSignal.aborted) {
          timeoutAbort.abort(callerSignal.reason);
        } else {
          callerSignal.addEventListener("abort", () => {
            timeoutAbort.abort(callerSignal.reason || "user_stop");
          }, { once: true });
        }
      }
      const result = await withTimeout(
        adapter.exec(framedMessage, { ...options, sessionId, model: effectiveModel, abortController: timeoutAbort }),
        timeoutMs,
        `${adapterName}.exec`,
        timeoutAbort,
      );

      if (result) {
        // Extract human-readable text from structured responses
        const text = typeof result === "string"
          ? result
          : result.finalResponse || result.text || result.message || JSON.stringify(result);
        tracker.recordEvent(sessionId, {
          role: "assistant",
          content: text,
          timestamp: new Date().toISOString(),
          _sessionType: sessionType,
        });
        const compressionSummary = summarizeContextCompressionItems(result?.items);
        if (compressionSummary) {
          tracker.recordEvent(sessionId, {
            role: "system",
            type: "system",
            content: compressionSummary.content,
            timestamp: new Date().toISOString(),
            meta: {
              contextCompression: compressionSummary,
            },
          });
        }
      }
      clearAdapterFailureState(adapterName);
      return result;
    } catch (err) {
      lastError = err;
      const isTimeout = err.message?.startsWith("AGENT_TIMEOUT");
      const isPrimaryAttempt = attempt === 0;
      console.error(
        `[primary-agent] ${isTimeout ? ":clock: Timeout" : ":close: Error"} with ${adapterName}: ${err.message}`,
      );

      if (
        isPrimaryAttempt &&
        PRIMARY_RECOVERY_RETRY_ATTEMPTS > 0 &&
        (isSessionScopedAdapterError(err) || isInfrastructureAdapterError(err))
      ) {
        for (let retry = 1; retry <= PRIMARY_RECOVERY_RETRY_ATTEMPTS; retry++) {
          try {
            console.warn(
              `[primary-agent] :arrows_counterclockwise: recovering ${adapterName} session (${retry}/${PRIMARY_RECOVERY_RETRY_ATTEMPTS})`,
            );
            tracker.recordEvent(sessionId, {
              role: "system",
              type: "recovery",
              content: `:arrows_counterclockwise: Recovering ${adapterName} session (${retry}/${PRIMARY_RECOVERY_RETRY_ATTEMPTS}) before any failover.`,
              timestamp: new Date().toISOString(),
            });
            await recoverAdapterSession(adapter, adapterName);
            const timeoutAbort = new AbortController();
            if (options.abortController?.signal) {
              const callerSignal = options.abortController.signal;
              if (callerSignal.aborted) {
                timeoutAbort.abort(callerSignal.reason);
              } else {
                callerSignal.addEventListener("abort", () => {
                  timeoutAbort.abort(callerSignal.reason || "user_stop");
                }, { once: true });
              }
            }
            const retryResult = await withTimeout(
              adapter.exec(framedMessage, { ...options, sessionId, model: effectiveModel, abortController: timeoutAbort }),
              timeoutMs,
              `${adapterName}.exec.retry`,
              timeoutAbort,
            );
            const retryText = typeof retryResult === "string"
              ? retryResult
              : retryResult.finalResponse || retryResult.text || retryResult.message || JSON.stringify(retryResult);
            tracker.recordEvent(sessionId, {
              role: "assistant",
              content: retryText,
              timestamp: new Date().toISOString(),
              _sessionType: sessionType,
            });
            clearAdapterFailureState(adapterName);
            return retryResult;
          } catch (retryErr) {
            lastError = retryErr;
            console.error(
              `[primary-agent] :close: recovery attempt ${retry}/${PRIMARY_RECOVERY_RETRY_ATTEMPTS} failed for ${adapterName}: ${retryErr?.message || retryErr}`,
            );
          }
        }
      }

      const failureState = noteAdapterFailure(adapterName, lastError);
      const shouldBlockPrimaryFailover =
        isPrimaryAttempt && !failureState.allowFailover;

      if (shouldBlockPrimaryFailover) {
        const waitReason = failureState.infrastructure
          ? `holding failover until ${FAILOVER_CONSECUTIVE_INFRA_ERRORS} consecutive infrastructure failures (${failureState.streak}/${FAILOVER_CONSECUTIVE_INFRA_ERRORS})`
          : "error classified as session-scoped/non-infrastructure";
        console.warn(
          `[primary-agent] failover suppressed for ${adapterName}: ${waitReason}`,
        );
        tracker.recordEvent(sessionId, {
          role: "system",
          type: "error",
          content: `:warning: ${adapterName} error: ${lastError?.message || "unknown error"}. Failover suppressed (${waitReason}).`,
          timestamp: new Date().toISOString(),
        });
        return {
          finalResponse: `:warning: ${adapterName} error: ${lastError?.message || "unknown error"}. Failover suppressed (${waitReason}).`,
          items: [],
          usage: null,
        };
      }

      // If this is the last adapter, report to user
      if (attempt >= maxAdaptersToTry - 1) {
        tracker.recordEvent(sessionId, {
          role: "system",
          type: "error",
          content: isTimeout
            ? `:clock: All agents timed out. The AI service may be experiencing issues. Your message was saved — please try again shortly.`
            : `:close: Agent error: ${err.message}. Your message was saved — please try again.`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // All adapters failed
  return {
    finalResponse: `:close: All agent adapters failed. Last error: ${lastError?.message || "unknown"}`,
    items: [],
    usage: null,
  };
}

export async function steerPrimaryPrompt(message) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  return activeAdapter.steer(message);
}

export function isPrimaryBusy() {
  return activeAdapter.isBusy();
}

export function getPrimaryAgentInfo() {
  const info = activeAdapter.getInfo ? activeAdapter.getInfo() : {};
  return {
    adapter: activeAdapter.name,
    selectionId: activeExecutorSelection || activeAdapter.name,
    provider: activeAdapter.provider,
    profile: primaryProfile,
    fallbackReason: primaryFallbackReason,
    sessionId: info.sessionId || info.threadId || null,
    threadId: info.threadId || null,
    turnCount: info.turnCount || 0,
    isActive: !!info.isActive,
    isBusy: !!info.isBusy,
  };
}

export async function resetPrimaryAgent() {
  if (!initialized) {
    await initPrimaryAgent();
  }
  if (activeAdapter.reset) {
    await activeAdapter.reset();
  }
}

export function getPrimarySessionId() {
  return activeAdapter.getSessionId ? activeAdapter.getSessionId() : null;
}

export async function listPrimarySessions() {
  return activeAdapter.listSessions ? activeAdapter.listSessions() : [];
}

export async function switchPrimarySession(id) {
  return activeAdapter.switchSession ? activeAdapter.switchSession(id) : undefined;
}

export async function createPrimarySession(id) {
  return activeAdapter.createSession ? activeAdapter.createSession(id) : undefined;
}

// ── Agent mode & SDK command API ─────────────────────────────────────────────

/**
 * Get the current interaction mode ("ask" | "agent" | "plan" | "web" | "instant").
 * @returns {string}
 */
export function getAgentMode() {
  return agentMode;
}

/**
 * Set the interaction mode.
 * @param {"ask"|"agent"|"plan"|"web"|"instant"} mode
 * @returns {{ ok: boolean, mode: string, error?: string }}
 */
export function setAgentMode(mode) {
  const normalized = normalizeAgentMode(mode, "");
  if (!getValidModes().includes(normalized)) {
    return { ok: false, mode: agentMode, error: `Invalid mode "${mode}". Valid: ${getValidModes().join(", ")}` };
  }
  agentMode = normalized;
  return { ok: true, mode: agentMode };
}

/**
 * Build the full prompt with mode prefix applied.
 * @param {string} userMessage
 * @returns {string}
 */
export function applyModePrefix(userMessage) {
  const prefix = getModePrefix(agentMode);
  return prefix ? prefix + userMessage : userMessage;
}

/**
 * Register a custom interaction mode at runtime.
 * Core modes cannot be overridden.
 * @param {string} id
 * @param {{ prefix?: string, execPolicy?: object|null, toolFilter?: object|null, description?: string }} config
 */
export function registerCustomMode(id, config) {
  if (!id || typeof id !== "string") return;
  const modeId = id.trim().toLowerCase();
  if (CORE_MODES.includes(modeId)) return;
  _customModes.set(modeId, {
    prefix: config.prefix || "",
    execPolicy: config.execPolicy || null,
    toolFilter: config.toolFilter || null,
    description: config.description || "",
  });
}

/**
 * List all available modes (core + custom) with metadata.
 * @returns {Array<{id: string, description: string, core: boolean}>}
 */
export function listAvailableModes() {
  const modes = CORE_MODES.map((m) => ({
    id: m,
    description: MODE_PREFIXES[m]?.slice(0, 80) || "Full agentic behavior",
    core: true,
  }));
  for (const [id, cfg] of _customModes) {
    modes.push({ id, description: cfg.description, core: false });
  }
  return modes;
}

/**
 * Get all registered custom modes.
 * @returns {Array<{id: string, prefix: string, execPolicy: object|null, toolFilter: object|null, description: string}>}
 */
export function getCustomModes() {
  return [..._customModes.entries()].map(([id, cfg]) => ({ id, ...cfg }));
}

/**
 * Get the list of available agent adapters with capabilities.
 * @returns {Array<{id:string, name:string, provider:string, available:boolean, busy:boolean, capabilities:object}>}
 */
export function getAvailableAgents() {
  let configExecutors = [];
  try {
    const cfg = loadConfig();
    configExecutors = Array.isArray(cfg?.executorConfig?.executors)
      ? cfg.executorConfig.executors
      : [];
  } catch {
    configExecutors = [];
  }

  if (configExecutors.length > 0) {
    return configExecutors.map((entry, index) => {
      const adapterId = executorToAdapter(entry?.executor);
      const adapter = ADAPTERS[adapterId] || ADAPTERS["codex-sdk"];
      const envDisabledKey = `${adapterId.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
      const sdkDisabled = envFlagEnabled(process.env[envDisabledKey]);
      const profileEnabled = entry?.enabled !== false;
      const configuredModels = Array.isArray(entry?.models)
        ? entry.models
            .map((model) => String(model || "").trim())
            .filter(Boolean)
        : [];
      const models = configuredModels.length > 0
        ? configuredModels
        : getModelsForExecutor(entry?.executor || adapter.provider);
      const name = String(entry?.name || "").trim() || adapter.displayName || adapter.name;
      return {
        id: name || `${adapterId}-${index + 1}`,
        name,
        provider: adapter.provider,
        executor: String(entry?.executor || "").toUpperCase() || adapter.provider,
        variant: String(entry?.variant || "DEFAULT"),
        adapterId,
        available: profileEnabled && !sdkDisabled,
        busy: profileEnabled && !sdkDisabled ? readAdapterBusy(adapter) : false,
        models,
        capabilities: getAdapterCapabilities(adapter),
      };
    });
  }

  return Object.entries(ADAPTERS).map(([id, adapter]) => {
    const envDisabledKey = `${id.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
    const disabled = envFlagEnabled(process.env[envDisabledKey]);
    return {
      id,
      name: adapter.displayName || adapter.name,
      provider: adapter.provider,
      executor: adapter.provider,
      variant: "DEFAULT",
      adapterId: id,
      available: !disabled,
      busy: readAdapterBusy(adapter),
      models: getModelsForExecutor(adapter.provider), // use provider ("CODEX"/"COPILOT"/"CLAUDE") — always in the alias map
      capabilities: getAdapterCapabilities(adapter),
    };
  });
}

/**
 * Get the list of SDK commands supported by a specific adapter (or the active one).
 * @param {string} [adapterName]
 * @returns {string[]}
 */
export function getSdkCommands(adapterName) {
  const adapter = adapterName ? ADAPTERS[adapterName] : activeAdapter;
  return adapter?.sdkCommands || [];
}

/**
 * Forward an SDK-native command to the active (or specified) adapter.
 * @param {string} command  — e.g. "/compact", "/model"
 * @param {string} [args]   — optional arguments string
 * @param {string} [adapterName] — target adapter (defaults to active)
 * @param {object} [options] — execution overrides (e.g. cwd/sessionId)
 * @returns {Promise<string|object>}
 */
export async function execSdkCommand(command, args = "", adapterName, options = {}) {
  const adapter = adapterName ? ADAPTERS[adapterName] : activeAdapter;
  if (!adapter) {
    throw new Error(`Unknown adapter: ${adapterName || "(none)"}`);
  }
  const cmd = command.startsWith("/") ? command : `/${command}`;
  if (!adapter.sdkCommands?.includes(cmd) && cmd !== "/clear") {
    throw new Error(`Command "${cmd}" not supported by ${adapter.name}. Supported: ${(adapter.sdkCommands || []).join(", ")}`);
  }
  if (typeof adapter.execSdkCommand !== "function") {
    throw new Error(`Adapter ${adapter.name} does not support SDK commands.`);
  }
  return adapter.execSdkCommand(cmd, args, options);
}


