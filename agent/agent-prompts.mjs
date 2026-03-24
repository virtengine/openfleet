import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { AGENT_PROMPT_DEFINITIONS, DEFAULT_PROMPTS, PROMPT_WORKSPACE_DIR } from "./agent-prompt-catalog.mjs";

export { AGENT_PROMPT_DEFINITIONS, PROMPT_WORKSPACE_DIR };

function normalizeTemplateValue(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    const sanitized = text
      .replace(/\{\{\s*[\w.-]+\s*\}\}/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return sanitized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asPathCandidates(pathValue, configDir, repoRoot) {
  if (!pathValue || typeof pathValue !== "string") return [];
  const raw = pathValue.trim();
  if (!raw) return [];
  if (raw.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return [resolve(home, raw.slice(1))];
  }
  if (isAbsolute(raw)) return [resolve(raw)];

  const candidates = [];
  if (repoRoot) candidates.push(resolve(repoRoot, raw));
  if (configDir) candidates.push(resolve(configDir, raw));
  // Only fall back to cwd when no explicit roots were provided.
  if (candidates.length === 0) {
    candidates.push(resolve(process.cwd(), raw));
  }

  return candidates.filter((p, idx, arr) => p && arr.indexOf(p) === idx);
}

function readTemplateFile(candidates) {
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      return { content: readFileSync(filePath, "utf8"), path: filePath };
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

export function getAgentPromptDefinitions() {
  return AGENT_PROMPT_DEFINITIONS;
}

export function getDefaultPromptWorkspace(repoRoot) {
  const override = String(
    process.env.BOSUN_PROMPT_WORKSPACE || "",
  ).trim();
  if (override) {
    return isAbsolute(override)
      ? override
      : resolve(repoRoot || process.cwd(), override);
  }
  return resolve(repoRoot || process.cwd(), PROMPT_WORKSPACE_DIR);
}

export function getDefaultPromptTemplate(key) {
  return DEFAULT_PROMPTS[key] || "";
}

function normalizePromptContentForComparison(content) {
  const text = String(content || "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);

  let index = 0;
  while (
    index < lines.length &&
    /^<!--\s*bosun\s+(prompt|description|default-sha256)\s*:\s*.*-->\s*$/i.test(
      lines[index],
    )
  ) {
    index += 1;
  }

  if (index > 0 && index < lines.length && lines[index].trim() === "") {
    index += 1;
  }

  return lines.slice(index).join("\n").trimEnd();
}

function computePromptSha256(content) {
  return createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

function computeNormalizedPromptSha256(content) {
  return computePromptSha256(normalizePromptContentForComparison(content));
}

function parsePromptRecordedDefaultHash(content) {
  const match = String(content || "").match(
    /<!--\s*bosun\s+default-sha256\s*:\s*([a-f0-9]{64})\s*-->/i,
  );
  return match ? match[1].toLowerCase() : null;
}

function buildPromptFileBody(definition, promptContent) {
  const normalizedPrompt = normalizePromptContentForComparison(promptContent);
  const defaultHash = computePromptSha256(normalizedPrompt);

  return [
    `<!-- bosun prompt: ${definition.key} -->`,
    `<!-- bosun description: ${definition.description} -->`,
    `<!-- bosun default-sha256: ${defaultHash} -->`,
    "",
    normalizedPrompt,
    "",
  ].join("\n");
}

export function renderPromptTemplate(template, values = {}, rootDir) {
  if (typeof template !== "string") return "";
  const normalized = {};
  for (const [k, v] of Object.entries(values || {})) {
    normalized[String(k).trim().toUpperCase()] = normalizeTemplateValue(v);
  }

  // Resolve namespaced library refs: {{prompt:name}}, {{agent:name}}, {{skill:name}}
  let result = template;
  if (rootDir && _libraryResolver) {
    try {
      result = _libraryResolver(result, rootDir, {});
    } catch {
      // library resolver failed — skip namespaced refs
    }
  }

  return result.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (full, key) => {
    const hit = normalized[String(key).toUpperCase()];
    return hit == null ? "" : hit;
  });
}

/**
 * Register the library reference resolver. Called by library-manager or at
 * startup to enable {{prompt:name}}, {{agent:name}}, {{skill:name}} syntax.
 *
 * @param {(template: string, rootDir: string, vars: Object) => string} resolver
 */
let _libraryResolver = null;
export function setLibraryResolver(resolver) {
  _libraryResolver = typeof resolver === "function" ? resolver : null;
}

export function resolvePromptTemplate(template, values, fallback) {
  const base = typeof fallback === "string" ? fallback : "";
  if (typeof template !== "string" || !template.trim()) return base;
  const rendered = renderPromptTemplate(template, {
    ...(values || {}),
    DEFAULT_PROMPT: base,
  });
  return rendered && rendered.trim() ? rendered : base;
}

export async function buildCustomToolsContextPrompt(rootDir, opts = {}) {
  const { getToolsPromptBlock, listCustomTools } = await import("./agent-custom-tools.mjs");
  const registeredTools = listCustomTools(rootDir, {
    includeBuiltins: false,
  });
  if (registeredTools.length === 0) return "";

  const promptTemplate = DEFAULT_PROMPTS.customToolsContext || "{{CUSTOM_TOOLS_BLOCK}}";
  const toolsBlock = getToolsPromptBlock(rootDir, opts);
  if (!toolsBlock.trim()) return "";

  return renderPromptTemplate(
    promptTemplate,
    {
      CUSTOM_TOOLS_BLOCK: toolsBlock,
    },
    rootDir,
  ).trim();
}

export function ensureAgentPromptWorkspace(repoRoot) {
  const root = resolve(repoRoot || process.cwd());
  let workspaceDir = getDefaultPromptWorkspace(root);

  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (err) {
    const fallbackRoot = resolve(
      process.env.BOSUN_HOME ||
        process.env.HOME ||
        process.env.USERPROFILE ||
        homedir(),
    );
    const fallbackDir = resolve(fallbackRoot, PROMPT_WORKSPACE_DIR);
    process.env.BOSUN_PROMPT_WORKSPACE = fallbackDir;
    workspaceDir = fallbackDir;
    mkdirSync(workspaceDir, { recursive: true });
    console.warn(
      `[agent-prompts] prompt workspace fallback enabled: ${workspaceDir} (primary path failed: ${err?.code || err?.message || err})`,
    );
  }

  const written = [];
  for (const def of AGENT_PROMPT_DEFINITIONS) {
    const filePath = resolve(workspaceDir, def.filename);
    if (existsSync(filePath)) continue;

    const body = buildPromptFileBody(def, DEFAULT_PROMPTS[def.key] || "");

    writeFileSync(filePath, body, "utf8");
    written.push(filePath);
  }

  return {
    workspaceDir,
    written,
  };
}

export function getPromptDefaultUpdateStatus(repoRoot) {
  const root = resolve(repoRoot || process.cwd());
  const workspaceDir = getDefaultPromptWorkspace(root);

  const updates = AGENT_PROMPT_DEFINITIONS.map((def) => {
    const filePath = resolve(workspaceDir, def.filename);
    const exists = existsSync(filePath);
    const defaultHash = computeNormalizedPromptSha256(DEFAULT_PROMPTS[def.key] || "");

    if (!exists) {
      return {
        key: def.key,
        filename: def.filename,
        filePath,
        exists: false,
        defaultHash,
        recordedDefaultHash: null,
        currentHash: null,
        updateAvailable: true,
        needsReview: false,
        reason: "missing",
      };
    }

    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return {
        key: def.key,
        filename: def.filename,
        filePath,
        exists: true,
        defaultHash,
        recordedDefaultHash: null,
        currentHash: null,
        updateAvailable: false,
        needsReview: true,
        reason: "read-failed",
      };
    }

    const recordedDefaultHash = parsePromptRecordedDefaultHash(content);
    const currentHash = computeNormalizedPromptSha256(content);

    let updateAvailable = false;
    let needsReview = false;
    let reason = "up-to-date";

    if (!recordedDefaultHash) {
      reason = "no-recorded-hash";
    } else if (recordedDefaultHash === defaultHash) {
      if (currentHash !== defaultHash) {
        needsReview = true;
        reason = "modified";
      }
    } else if (currentHash === recordedDefaultHash) {
      updateAvailable = true;
      reason = "default-updated";
    } else {
      needsReview = true;
      reason = "modified";
    }

    return {
      key: def.key,
      filename: def.filename,
      filePath,
      exists: true,
      defaultHash,
      recordedDefaultHash,
      currentHash,
      updateAvailable,
      needsReview,
      reason,
    };
  });

  const summary = {
    total: updates.length,
    missing: updates.filter((entry) => !entry.exists).length,
    upToDate: updates.filter(
      (entry) =>
        entry.exists &&
        entry.currentHash === entry.defaultHash &&
        entry.recordedDefaultHash === entry.defaultHash,
    ).length,
    updateAvailable: updates.filter((entry) => entry.updateAvailable).length,
    needsReview: updates.filter((entry) => entry.needsReview).length,
  };

  return {
    workspaceDir,
    updates,
    summary,
  };
}

export function applyPromptDefaultUpdates(repoRoot, options = {}) {
  const status = getPromptDefaultUpdateStatus(repoRoot);
  const keysFilter = Array.isArray(options?.keys)
    ? new Set(options.keys.map((key) => String(key)))
    : null;

  mkdirSync(status.workspaceDir, { recursive: true });

  const updated = [];
  const skipped = [];

  for (const entry of status.updates) {
    if (keysFilter && !keysFilter.has(entry.key)) {
      skipped.push({ key: entry.key, reason: "filtered" });
      continue;
    }

    if (!entry.updateAvailable) {
      skipped.push({ key: entry.key, reason: entry.reason });
      continue;
    }

    const def = AGENT_PROMPT_DEFINITIONS.find((item) => item.key === entry.key);
    if (!def) {
      skipped.push({ key: entry.key, reason: "definition-missing" });
      continue;
    }

    try {
      const body = buildPromptFileBody(def, DEFAULT_PROMPTS[def.key] || "");
      writeFileSync(entry.filePath, body, "utf8");
      updated.push(entry.key);
    } catch {
      skipped.push({ key: entry.key, reason: "write-failed" });
    }
  }

  return {
    workspaceDir: status.workspaceDir,
    updated,
    skipped,
  };
}

export function resolveAgentPrompts(configDir, repoRoot, configData = {}) {
  const workspaceDir = getDefaultPromptWorkspace(repoRoot);
  const configured =
    configData && typeof configData.agentPrompts === "object"
      ? configData.agentPrompts
      : {};

  const prompts = {};
  const sources = {};

  for (const def of AGENT_PROMPT_DEFINITIONS) {
    const fallback = DEFAULT_PROMPTS[def.key] || "";
    const envPath = process.env[def.envVar];
    const configuredPath = configured?.[def.key];

    const candidates = [
      ...asPathCandidates(envPath, configDir, repoRoot),
      ...asPathCandidates(configuredPath, configDir, repoRoot),
      resolve(workspaceDir, def.filename),
    ];

    const loaded = readTemplateFile(candidates);
    prompts[def.key] = loaded?.content || fallback;
    sources[def.key] = {
      source: loaded
        ? envPath
          ? "env"
          : configuredPath
            ? "config"
            : "workspace"
        : "builtin",
      path: loaded?.path || null,
      envVar: def.envVar,
      filename: def.filename,
    };
  }

  return {
    prompts,
    sources,
    workspaceDir,
  };
}
