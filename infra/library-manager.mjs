/**
 * library-manager.mjs — Centralized Library for Prompts, Agents & Skills
 *
 * Provides a unified registry that workflows and task executors can reference
 * via `{{prompt:name}}`, `{{agent:name}}`, and `{{skill:name}}` interpolation.
 *
 * Storage layout:
 *   .bosun/agents/       — Prompt markdown files (existing convention)
 *   .bosun/skills/       — Skill markdown files (existing convention)
 *   .bosun/profiles/     — Agent profile JSON files (new)
 *   .bosun/library.json  — Unified manifest (index of all library items)
 *
 * Multi-workspace aware:
 *   Per-workspace overrides are stored under each workspace's root directory,
 *   falling back to the global BOSUN_HOME location.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs";
import { resolve, basename, join, relative } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { getAgentToolConfig, getEffectiveTools } from "../agent/agent-tool-config.mjs";

// ── Constants ─────────────────────────────────────────────────────────────────

export const LIBRARY_MANIFEST = "library.json";
export const PROMPT_DIR = ".bosun/agents";
export const SKILL_DIR = ".bosun/skills";
export const PROFILE_DIR = ".bosun/profiles";
export const MCP_DIR = ".bosun/mcp-servers";
export const TOOL_DIR = ".bosun/tools";
export const LIBRARY_INDEX_DIR = ".bosun/library-index";
export const AGENT_PROFILE_INDEX = "agent-profiles.json";
export const SKILL_ENTRY_INDEX = "skills.json";

const agentProfileIndexCache = new Map();
const skillEntryIndexCache = new Map();
const wellKnownSourceProbeCache = new Map();

/** Resource types managed by the library */
export const RESOURCE_TYPES = Object.freeze(["prompt", "agent", "skill", "mcp", "custom-tool"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getBosunHomeDir() {
  const explicit = process.env.BOSUN_HOME || process.env.BOSUN_DIR;
  if (explicit) return resolve(String(explicit));
  const modernDefault = resolve(homedir(), "bosun");
  if (existsSync(modernDefault)) return modernDefault;
  return resolve(homedir(), ".bosun");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeReadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  ensureDir(resolve(filePath, ".."));
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function getFileMtimeMs(filePath) {
  try {
    return Number(statSync(filePath)?.mtimeMs || 0);
  } catch {
    return 0;
  }
}

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function nowISO() {
  return new Date().toISOString();
}

function isSafeGitRefName(value) {
  const ref = String(value || "").trim();
  if (!ref) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("//")) return false;
  if (ref.endsWith("/") || ref.endsWith(".")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref);
}

function isSafeGitRepositorySource(value) {
  const source = String(value || "").trim();
  if (!source) return false;
  if (existsSync(source)) {
    return true;
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/i.test(source)) {
    return true;
  }
  try {
    const parsed = new URL(source);
    if (!["http:", "https:", "ssh:", "file:"].includes(parsed.protocol)) return false;
    return Boolean(parsed.hostname || parsed.protocol === "file:");
  } catch {
    return false;
  }
}

function toStringArray(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item || '').trim()).filter(Boolean);
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function keywordTokens(value, { minLength = 3 } = {}) {
  return uniqueStrings(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= minLength),
  );
}

function parseJsonishArray(value) {
  if (Array.isArray(value)) return toStringArray(value);
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.replace(/'/g, '"'));
    return Array.isArray(parsed) ? toStringArray(parsed) : [];
  } catch {
    return raw
      .split(/[\s,]+/)
      .map((v) => String(v || '').trim())
      .filter(Boolean);
  }
}

function extractConventionalScope(taskTitle = '') {
  const normalized = String(taskTitle || '').toLowerCase();
  if (!normalized) return null;

  let cursor = 0;
  if (normalized.startsWith('[')) {
    const closingBracket = normalized.indexOf(']');
    if (closingBracket > 0) cursor = closingBracket + 1;
  }

  const candidate = normalized.slice(cursor).trimStart();
  const types = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
  for (const type of types) {
    const prefix = type + '(';
    if (!candidate.startsWith(prefix)) continue;
    const closingParen = candidate.indexOf(')', prefix.length);
    if (closingParen <= prefix.length) return null;
    const scope = candidate.slice(prefix.length, closingParen).trim();
    return scope || null;
  }
  return null;
}

function parseMatchEnvNumber(name, fallback) {
  const raw = Number.parseFloat(String(process.env[name] || '').trim());
  return Number.isFinite(raw) ? raw : fallback;
}

function buildTypeIndexRevision(manifest, type) {
  const entries = Array.isArray(manifest?.entries)
    ? manifest.entries.filter((entry) => entry?.type === type)
    : [];
  return entries
    .slice()
    .sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")))
    .map((entry) => [entry.id, entry.filename, entry.updatedAt].join(":"))
    .join("|");
}

function buildAgentProfileIndexRevision(manifest) {
  return buildTypeIndexRevision(manifest, "agent");
}

function buildSkillIndexRevision(manifest) {
  return buildTypeIndexRevision(manifest, "skill");
}

function updateIndexCache(cache, rootDir, index, manifestMtimeMs = 0) {
  const cacheKey = resolve(rootDir || getBosunHomeDir());
  const payload = {
    ...index,
    count: Array.isArray(index?.profiles)
      ? index.profiles.length
      : Array.isArray(index?.skills)
        ? index.skills.length
        : Number(index?.count || 0),
  };
  cache.set(cacheKey, {
    manifestMtimeMs: Number(manifestMtimeMs || 0),
    index: payload,
  });
  return payload;
}

function updateAgentProfileIndexCache(rootDir, index, manifestMtimeMs = 0) {
  return updateIndexCache(agentProfileIndexCache, rootDir, index, manifestMtimeMs);
}

function updateSkillEntryIndexCache(rootDir, index, manifestMtimeMs = 0) {
  return updateIndexCache(skillEntryIndexCache, rootDir, index, manifestMtimeMs);
}

function buildIndexedAgentProfile(rootDir, entry) {
  const profile = getEntryContent(rootDir, entry);
  if (!profile || typeof profile !== "object") return null;
  return {
    ...entry,
    profile,
    agentType: String(profile?.agentType || "task").trim().toLowerCase() || "task",
    titlePatterns: toStringArray(profile?.titlePatterns),
    scopes: toStringArray(profile?.scopes),
    tags: uniqueStrings([...(entry?.tags || []), ...toStringArray(profile?.tags)]),
  };
}

function buildIndexedSkillEntry(entry) {
  const tags = uniqueStrings(entry?.tags || []);
  const keywords = keywordTokens(
    [entry?.id, entry?.name, entry?.description, ...tags].filter(Boolean).join(" "),
    { minLength: 3 },
  );
  return {
    ...entry,
    tags,
    keywords,
  };
}

function buildSkillSelection(rootDir, best, criteria = {}, opts = {}) {
  const skillIndex = loadSkillEntryIndex(rootDir);
  const indexedSkills = Array.isArray(skillIndex?.skills) ? skillIndex.skills : [];
  const tokenMap = skillIndex?.tokenMap || {};
  const indexedById = new Map(indexedSkills.map((entry) => [entry.id, entry]));
  const profileSkillIds = toStringArray(best?.profile?.skills);
  const textBlob = [criteria?.title, criteria?.description].filter(Boolean).join("\n");
  const criteriaTags = uniqueStrings([
    ...toStringArray(criteria?.tags),
    ...keywordTokens(textBlob, { minLength: 4 }),
    ...keywordTokens(toStringArray(criteria?.changedFiles).join(" "), { minLength: 3 }),
  ]).map((value) => value.toLowerCase());

  const candidateIds = new Set(profileSkillIds);
  for (const tag of criteriaTags) {
    const ids = Array.isArray(tokenMap?.[tag]) ? tokenMap[tag] : [];
    if (ids.length > 128) continue;
    for (const id of ids) candidateIds.add(id);
  }

  const scored = [];
  const profileSkillSet = new Set(profileSkillIds.map((value) => value.toLowerCase()));
  const candidateEntries = candidateIds.size > 0
    ? [...candidateIds].map((id) => indexedById.get(id)).filter(Boolean)
    : [];
  for (const skill of candidateEntries) {
    let score = 0;
    const reasons = [];
    if (profileSkillSet.has(String(skill.id || "").toLowerCase())) {
      score += 12;
      reasons.push("profile-skill");
    }

    const haystack = new Set([
      ...skill.tags.map((value) => String(value || "").toLowerCase()),
      ...skill.keywords.map((value) => String(value || "").toLowerCase()),
      String(skill.id || "").toLowerCase(),
    ]);
    const tagHits = criteriaTags.filter((tag) => haystack.has(tag));
    if (tagHits.length > 0) {
      score += Math.min(6, tagHits.length * 2);
      reasons.push(`tags:${tagHits.slice(0, 4).join(",")}`);
    }

    if (score <= 0) continue;
    scored.push({
      ...skill,
      score,
      reasons,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const skillTopN = Math.max(1, Number.parseInt(String(opts?.skillTopN ?? criteria?.skillTopN ?? 6), 10) || 6);
  const selectedSkillIds = uniqueStrings([
    ...profileSkillIds,
    ...scored.slice(0, skillTopN).map((entry) => entry.id),
  ]);
  const selectedSkills = selectedSkillIds
    .map((skillId) => scored.find((entry) => entry.id === skillId) || indexedSkills.find((entry) => entry.id === skillId))
    .filter(Boolean);

  return {
    selectedSkillIds,
    selectedSkills,
    candidates: scored.slice(0, skillTopN),
  };
}

function resolvePromptSelection(rootDir, profile = {}) {
  const promptOverrideId = String(profile?.promptOverride || "").trim();
  if (!promptOverrideId) return null;
  const entry = getEntry(rootDir, promptOverrideId);
  if (!entry) {
    return {
      id: promptOverrideId,
      type: "inline-or-missing",
      name: promptOverrideId,
      description: "Prompt override is inline text or not present in the local library registry.",
    };
  }
  return {
    id: entry.id,
    type: "library-entry",
    name: entry.name,
    description: entry.description,
  };
}

function resolveToolSelection(rootDir, best) {
  const profile = best?.profile || {};
  const profileEnabledTools = toStringArray(profile?.enabledTools);
  const profileEnabledMcpServers = toStringArray(profile?.enabledMcpServers);
  const rawCfg = best?.id
    ? getAgentToolConfig(rootDir, best.id)
    : { enabledTools: null, enabledMcpServers: [], disabledBuiltinTools: [] };
  const effective = best?.id
    ? getEffectiveTools(rootDir, best.id)
    : { builtinTools: [], mcpServers: [] };

  const builtinToolIds = Array.isArray(effective?.builtinTools)
    ? effective.builtinTools.filter((tool) => tool?.enabled).map((tool) => tool.id)
    : [];
  const recommendedToolIds = uniqueStrings([
    ...toStringArray(rawCfg?.enabledTools),
    ...profileEnabledTools,
    ...builtinToolIds,
  ]);
  const enabledMcpServers = uniqueStrings([
    ...profileEnabledMcpServers,
    ...toStringArray(rawCfg?.enabledMcpServers),
    ...toStringArray(effective?.mcpServers),
  ]);

  return {
    builtinToolIds,
    recommendedToolIds,
    enabledMcpServers,
    disabledBuiltinTools: toStringArray(rawCfg?.disabledBuiltinTools),
  };
}

export function getLibraryIndexDir(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), LIBRARY_INDEX_DIR);
}

export function getAgentProfileIndexPath(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), LIBRARY_INDEX_DIR, AGENT_PROFILE_INDEX);
}

export function getSkillEntryIndexPath(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), LIBRARY_INDEX_DIR, SKILL_ENTRY_INDEX);
}

export function rebuildAgentProfileIndex(rootDir, manifest = loadManifest(rootDir)) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const profiles = (manifest?.entries || [])
    .filter((entry) => entry?.type === "agent")
    .map((entry) => buildIndexedAgentProfile(normalizedRoot, entry))
    .filter(Boolean);

  const index = {
    generated: nowISO(),
    revision: buildAgentProfileIndexRevision(manifest),
    count: profiles.length,
    profiles,
  };
  safeWriteJson(getAgentProfileIndexPath(normalizedRoot), index);
  return updateAgentProfileIndexCache(normalizedRoot, index, getFileMtimeMs(getManifestPath(normalizedRoot)));
}

export function loadAgentProfileIndex(rootDir, options = {}) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const manifestPath = getManifestPath(normalizedRoot);
  const manifestMtimeMs = getFileMtimeMs(manifestPath);
  const cacheEntry = agentProfileIndexCache.get(normalizedRoot);
  if (cacheEntry && cacheEntry.manifestMtimeMs === manifestMtimeMs) {
    return cacheEntry.index;
  }

  const manifest = loadManifest(normalizedRoot);
  const revision = buildAgentProfileIndexRevision(manifest);
  const existing = safeReadJson(getAgentProfileIndexPath(normalizedRoot));
  if (existing && existing.revision === revision && Array.isArray(existing.profiles)) {
    return updateAgentProfileIndexCache(
      normalizedRoot,
      {
        generated: String(existing.generated || nowISO()),
        revision,
        count: existing.profiles.length,
        profiles: existing.profiles,
      },
      manifestMtimeMs,
    );
  }

  if (options?.allowRebuild === false) {
    return updateAgentProfileIndexCache(
      normalizedRoot,
      { generated: nowISO(), revision, count: 0, profiles: [] },
      manifestMtimeMs,
    );
  }

  return rebuildAgentProfileIndex(normalizedRoot, manifest);
}

export function listIndexedAgentProfiles(rootDir, options = {}) {
  const index = loadAgentProfileIndex(rootDir, options);
  return Array.isArray(index?.profiles) ? index.profiles : [];
}

export function rebuildSkillEntryIndex(rootDir, manifest = loadManifest(rootDir)) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const skills = (manifest?.entries || [])
    .filter((entry) => entry?.type === "skill")
    .map((entry) => buildIndexedSkillEntry(entry));

  const tokenMap = {};
  for (const skill of skills) {
    const tokens = uniqueStrings([
      String(skill.id || "").toLowerCase(),
      ...skill.tags.map((value) => String(value || "").toLowerCase()),
      ...skill.keywords.map((value) => String(value || "").toLowerCase()),
    ]);
    for (const token of tokens) {
      if (!tokenMap[token]) tokenMap[token] = [];
      tokenMap[token].push(skill.id);
    }
  }

  const index = {
    generated: nowISO(),
    revision: buildSkillIndexRevision(manifest),
    count: skills.length,
    skills,
    tokenMap,
  };
  safeWriteJson(getSkillEntryIndexPath(normalizedRoot), index);
  return updateSkillEntryIndexCache(normalizedRoot, index, getFileMtimeMs(getManifestPath(normalizedRoot)));
}

export function loadSkillEntryIndex(rootDir, options = {}) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const manifestPath = getManifestPath(normalizedRoot);
  const manifestMtimeMs = getFileMtimeMs(manifestPath);
  const cacheEntry = skillEntryIndexCache.get(normalizedRoot);
  if (cacheEntry && cacheEntry.manifestMtimeMs === manifestMtimeMs) {
    return cacheEntry.index;
  }

  const manifest = loadManifest(normalizedRoot);
  const revision = buildSkillIndexRevision(manifest);
  const existing = safeReadJson(getSkillEntryIndexPath(normalizedRoot));
  if (existing && existing.revision === revision && Array.isArray(existing.skills)) {
    return updateSkillEntryIndexCache(
      normalizedRoot,
      {
        generated: String(existing.generated || nowISO()),
        revision,
        count: existing.skills.length,
        skills: existing.skills,
        tokenMap: existing.tokenMap || {},
      },
      manifestMtimeMs,
    );
  }

  if (options?.allowRebuild === false) {
    return updateSkillEntryIndexCache(
      normalizedRoot,
      { generated: nowISO(), revision, count: 0, skills: [], tokenMap: {} },
      manifestMtimeMs,
    );
  }

  return rebuildSkillEntryIndex(normalizedRoot, manifest);
}

export function listIndexedSkillEntries(rootDir, options = {}) {
  const index = loadSkillEntryIndex(rootDir, options);
  return Array.isArray(index?.skills) ? index.skills : [];
}

export function resolveLibraryPlan(rootDir, criteria = {}, opts = {}) {
  const match = matchAgentProfiles(rootDir, criteria, opts);
  const best = match?.best || null;
  if (!best) {
    return {
      ...match,
      plan: null,
      alternatives: [],
    };
  }

  const skillSelection = buildSkillSelection(rootDir, best, criteria, opts);
  const prompt = resolvePromptSelection(rootDir, best.profile || {});
  const toolSelection = resolveToolSelection(rootDir, best);

  const plan = {
    planId: `resolve-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    agentProfileId: best.id,
    agentName: best.name,
    prompt,
    skillIds: skillSelection.selectedSkillIds,
    selectedSkills: skillSelection.selectedSkills,
    builtinToolIds: toolSelection.builtinToolIds,
    recommendedToolIds: toolSelection.recommendedToolIds,
    enabledMcpServers: toolSelection.enabledMcpServers,
    disabledBuiltinTools: toolSelection.disabledBuiltinTools,
    confidence: Number(best.confidence || 0),
    autoApply: Boolean(match?.auto?.shouldAutoApply),
    reasons: uniqueStrings([
      ...toStringArray(best?.reasons),
      ...skillSelection.selectedSkills.flatMap((entry) => toStringArray(entry?.reasons)),
    ]),
  };

  return {
    ...match,
    plan,
    alternatives: (match?.candidates || []).slice(1).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      score: candidate.score,
      confidence: candidate.confidence,
      reasons: candidate.reasons,
    })),
  };
}

// ── Manifest (library.json) ──────────────────────────────────────────────────

/**
 * @typedef {Object} LibraryEntry
 * @property {string} id          - unique slug
 * @property {"prompt"|"agent"|"skill"} type
 * @property {string} name        - human-readable name
 * @property {string} description - one-line summary
 * @property {string} filename    - relative path within the type-specific dir
 * @property {string[]} tags      - free-form search tags
 * @property {string} [scope]     - workspace scope or "global"
 * @property {string} [workspace] - workspace name (null = global)
 * @property {Object} [meta]      - type-specific metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} AgentProfile
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} titlePatterns    - regex patterns matching task titles
 * @property {string[]} scopes           - conventional-commit scopes this agent handles
 * @property {string} [sdk]              - preferred SDK (COPILOT/CODEX/CLAUDE_CODE)
 * @property {string} [model]            - preferred model
 * @property {string} [promptOverride]   - prompt library ref (id) to use
 * @property {string[]} [skills]         - skill library refs to inject
 * @property {Object} [hookProfile]      - hook profile overrides
 * @property {Object} [env]              - extra env vars for the agent
 * @property {string[]} [enabledTools]   - list of tool IDs enabled for this agent (null = all)
 * @property {string[]} [enabledMcpServers] - list of MCP server IDs enabled for this agent
 */

/**
 * Get the manifest path for a workspace (or global).
 */
export function getManifestPath(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), ".bosun", LIBRARY_MANIFEST);
}

/**
 * Load the library manifest.
 * @param {string} [rootDir] - workspace root or BOSUN_HOME
 * @returns {{ entries: LibraryEntry[], generated: string }}
 */
export function loadManifest(rootDir) {
  const manifestPath = getManifestPath(rootDir);
  const data = safeReadJson(manifestPath);
  if (data && Array.isArray(data.entries)) return data;
  return { entries: [], generated: nowISO() };
}

/**
 * Save the library manifest.
 */
export function saveManifest(rootDir, manifest) {
  const manifestPath = getManifestPath(rootDir);
  manifest.generated = nowISO();
  safeWriteJson(manifestPath, manifest);
  return manifestPath;
}

// ── CRUD operations ──────────────────────────────────────────────────────────

function dirForType(rootDir, type) {
  const root = rootDir || getBosunHomeDir();
  switch (type) {
    case "prompt": return resolve(root, PROMPT_DIR);
    case "skill":  return resolve(root, SKILL_DIR);
    case "agent":  return resolve(root, PROFILE_DIR);
    case "mcp":    return resolve(root, MCP_DIR);
    case "custom-tool": return resolve(root, TOOL_DIR);
    default: throw new Error(`Unknown library resource type: ${type}`);
  }
}

function extForType(type) {
  if (type === "agent" || type === "mcp") return ".json";
  if (type === "custom-tool") return ".json"; // tools/index.json is the authoritative source
  return ".md";
}

/**
 * List all entries from the manifest, optionally filtered.
 */
export function listEntries(rootDir, { type, tags, scope, search } = {}) {
  const { entries } = loadManifest(rootDir);
  let filtered = entries;
  if (type) filtered = filtered.filter((e) => e.type === type);
  if (scope) filtered = filtered.filter((e) => e.scope === scope || e.scope === "global");
  if (tags && tags.length) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    filtered = filtered.filter((e) => e.tags.some((t) => tagSet.has(t)));
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.id.includes(q) ||
        e.tags.some((t) => t.includes(q)),
    );
  }
  return filtered;
}

/**
 * Get a single entry by id.
 */
export function getEntry(rootDir, id) {
  const { entries } = loadManifest(rootDir);
  return entries.find((e) => e.id === id) || null;
}

/**
 * Get the content (file body) for an entry.
 */
export function getEntryContent(rootDir, entry) {
  if (!entry) return null;
  const dir = dirForType(rootDir, entry.type);
  const filePath = resolve(dir, entry.filename);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    if (entry.type === "agent" || entry.type === "mcp" || entry.type === "custom-tool") {
      return JSON.parse(raw);
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Create or update a library entry.
 * @param {string} rootDir
 * @param {Partial<LibraryEntry>} data - must include at least type, name
 * @param {string|Object} [content]    - file content (md string or JSON object)
 * @returns {LibraryEntry}
 */
export function upsertEntry(rootDir, data, content, options = {}) {
  if (!data.type || !RESOURCE_TYPES.includes(data.type)) {
    throw new Error(`Invalid resource type: ${data.type}`);
  }
  if (!data.name) throw new Error("Entry name is required");

  const manifest = loadManifest(rootDir);
  const id = data.id || slugify(data.name);
  const existingIdx = manifest.entries.findIndex((e) => e.id === id);
  const existing = existingIdx >= 0 ? manifest.entries[existingIdx] : null;

  const entry = {
    id,
    type: data.type,
    name: data.name,
    description: data.description || existing?.description || "",
    filename: data.filename || existing?.filename || `${id}${extForType(data.type)}`,
    tags: data.tags || existing?.tags || [],
    scope: data.scope || existing?.scope || "global",
    workspace: data.workspace ?? existing?.workspace ?? null,
    meta: { ...(existing?.meta || {}), ...(data.meta || {}) },
    createdAt: existing?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };

  // Write content file
  if (content !== undefined) {
    const dir = ensureDir(dirForType(rootDir, entry.type));
    const filePath = resolve(dir, entry.filename);
    const body = typeof content === "object" ? JSON.stringify(content, null, 2) + "\n" : String(content);
    writeFileSync(filePath, body, "utf8");
  }

  // Update manifest
  if (existingIdx >= 0) {
    manifest.entries[existingIdx] = entry;
  } else {
    manifest.entries.push(entry);
  }
  saveManifest(rootDir, manifest);
  if (options?.skipIndexSync !== true) {
    if (data.type === "agent") rebuildAgentProfileIndex(rootDir, manifest);
    if (data.type === "skill") rebuildSkillEntryIndex(rootDir, manifest);
  }

  return entry;
}

/**
 * Delete a library entry by id. Removes from manifest (optionally deletes file).
 */
export function deleteEntry(rootDir, id, { deleteFile = false, syncIndexes = true } = {}) {
  const manifest = loadManifest(rootDir);
  const idx = manifest.entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;

  const entry = manifest.entries[idx];
  manifest.entries.splice(idx, 1);
  saveManifest(rootDir, manifest);
  if (syncIndexes !== false) {
    if (entry.type === "agent") rebuildAgentProfileIndex(rootDir, manifest);
    if (entry.type === "skill") rebuildSkillEntryIndex(rootDir, manifest);
  }

  if (deleteFile) {
    const filePath = resolve(dirForType(rootDir, entry.type), entry.filename);
    try {
      unlinkSync(filePath);
    } catch { /* file may not exist */ }
  }
  return true;
}

// ── Agent Profiles ───────────────────────────────────────────────────────────

/**
 * List all agent profiles.
 */
export function listAgentProfiles(rootDir) {
  return listEntries(rootDir, { type: "agent" }).map((e) => {
    const profile = getEntryContent(rootDir, e);
    return { ...e, profile };
  });
}

/**
 * Match a task to an agent profile based on title patterns and scopes.
 * Returns the best matching profile or null.
 *
 * @param {string} rootDir
 * @param {string} taskTitle
 * @returns {AgentProfile|null}
 */
export function matchAgentProfiles(rootDir, criteria = {}, opts = {}) {
  const title = String(criteria?.title || "").trim();
  const description = String(criteria?.description || "").trim();
  const requestedAgentType = String(criteria?.agentType || "").trim().toLowerCase();
  const topN = Math.max(1, Number.parseInt(String(opts?.topN ?? criteria?.topN ?? 5), 10) || 5);
  if (!title && !description) {
    return {
      best: null,
      candidates: [],
      auto: { shouldAutoApply: false, reason: "empty-input" },
      context: { title: "", description: "", requestedAgentType },
    };
  }

  const profiles = listIndexedAgentProfiles(rootDir);
  const taskScope = extractConventionalScope(title);
  const textBlob = `${title}\n${description}`.trim();
  const textBlobLower = textBlob.toLowerCase();
  const criteriaTags = uniqueStrings([
    ...toStringArray(criteria?.tags),
    ...toStringArray(String(criteria?.tagsCsv || "").split(",")),
    ...keywordTokens(textBlob, { minLength: 4 }),
  ]).map((v) => v.toLowerCase());
  const changedFiles = toStringArray(criteria?.changedFiles);
  const changedHints = keywordTokens(changedFiles.join(" "), { minLength: 3 });

  const candidates = [];
  for (const entry of profiles) {
    const profile = entry.profile;
    if (!profile) continue;

    const profileType = String(profile?.agentType || "task").trim().toLowerCase() || "task";
    if (requestedAgentType && profileType && requestedAgentType !== profileType) continue;

    let score = 0;
    const reasons = [];

    const patterns = toStringArray(profile.titlePatterns);
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, "i").test(textBlob)) {
          score += 10;
          reasons.push(`pattern:${pattern}`);
          break;
        }
      } catch {
        // ignore invalid regex
      }
    }

    const scopes = toStringArray(profile.scopes).map((s) => s.toLowerCase());
    if (taskScope && scopes.includes(taskScope)) {
      score += 6;
      reasons.push(`scope:${taskScope}`);
    }

    const profileTags = uniqueStrings([...(entry.tags || []), ...toStringArray(profile.tags)]).map((v) => v.toLowerCase());
    const tagHits = criteriaTags.filter((tag) => profileTags.includes(tag));
    if (tagHits.length > 0) {
      const tagScore = Math.min(6, tagHits.length * 2);
      score += tagScore;
      reasons.push(`tags:${tagHits.slice(0, 4).join(",")}`);
    }

    if (profileType === "voice") {
      const voiceHint = /\bvoice\b|\bcall\b|\brealtime\b/.test(textBlobLower);
      if (voiceHint) {
        score += 3;
        reasons.push("voice-hint");
      }
    }

    const scopeHitsFromPaths = scopes.filter((scope) =>
      changedHints.includes(scope) || changedFiles.some((f) => String(f).toLowerCase().includes(`/${scope}/`) || String(f).toLowerCase().includes(`\\${scope}\\`)),
    );
    if (scopeHitsFromPaths.length > 0) {
      const fileScore = Math.min(8, scopeHitsFromPaths.length * 2);
      score += fileScore;
      reasons.push(`paths:${scopeHitsFromPaths.slice(0, 4).join(",")}`);
    }

    if (score <= 0) continue;

    const confidence = Math.max(0, Math.min(1, score / 24));
    candidates.push({
      ...entry,
      agentType: profileType,
      score,
      confidence,
      reasons,
      matchedScope: taskScope,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const best = candidates[0] || null;
  const runnerUp = candidates[1] || null;
  const minScore = parseMatchEnvNumber("BOSUN_AGENT_MATCH_AUTO_MIN_SCORE", 12);
  const minConfidence = parseMatchEnvNumber("BOSUN_AGENT_MATCH_AUTO_MIN_CONFIDENCE", 0.72);
  const minDelta = parseMatchEnvNumber("BOSUN_AGENT_MATCH_AUTO_MIN_DELTA", 3);
  const shouldAutoApply = Boolean(
    best
      && Number(best.score || 0) >= minScore
      && Number(best.confidence || 0) >= minConfidence
      && (Number(best.score || 0) - Number(runnerUp?.score || 0)) >= minDelta,
  );

  return {
    best,
    candidates: candidates.slice(0, topN),
    auto: {
      shouldAutoApply,
      reason: shouldAutoApply ? "high-confidence" : "below-threshold",
      thresholds: { minScore, minConfidence, minDelta },
      runnerUpScore: Number(runnerUp?.score || 0),
    },
    context: {
      title,
      description,
      requestedAgentType,
      taskScope,
      changedFilesCount: changedFiles.length,
    },
  };
}

/**
 * Backward-compatible single-best match helper.
 *
 * @param {string} rootDir
 * @param {string} taskTitle
 * @returns {AgentProfile|null}
 */
export function matchAgentProfile(rootDir, taskTitle) {
  const result = matchAgentProfiles(rootDir, { title: taskTitle }, { topN: 1 });
  return result.best || null;
}

const TRUSTED_GITHUB_OWNERS = new Set(["microsoft", "github", "azure", "desktop", "canonical", "mastra-ai"]);

export const WELL_KNOWN_AGENT_SOURCES = Object.freeze([
  // ── Microsoft — Official ──────────────────────────────────────────────────
  {
    id: "microsoft-skills",
    name: "Microsoft Skills",
    repoUrl: "https://github.com/microsoft/skills.git",
    defaultBranch: "main",
    description: "Microsoft-maintained backend, frontend, planner, infrastructure, and scaffolder agents with hundreds of Azure SDK skills.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "high",
    focuses: ["backend", "frontend", "planner", "infra", "scaffolding", "azure"],
  },
  {
    id: "microsoft-hve-core",
    name: "Microsoft HVE Core",
    repoUrl: "https://github.com/microsoft/hve-core.git",
    defaultBranch: "main",
    description: "Core HVE agent library with domain and plugin agent templates and experimental skills.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "high",
    focuses: ["core", "plugins", "platform"],
  },
  {
    id: "microsoft-vscode",
    name: "Microsoft VS Code",
    repoUrl: "https://github.com/microsoft/vscode.git",
    defaultBranch: "main",
    description: "VS Code editor skills for hygiene, testing, and extension development workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["vscode", "editor", "extensions", "testing"],
  },
  {
    id: "microsoft-powertoys",
    name: "Microsoft PowerToys",
    repoUrl: "https://github.com/microsoft/PowerToys.git",
    defaultBranch: "main",
    description: "PowerToys development skills for Windows utility and plugin engineering.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["windows", "utilities", "c-sharp", "plugins"],
  },
  {
    id: "microsoft-typespec",
    name: "Microsoft TypeSpec",
    repoUrl: "https://github.com/microsoft/typespec.git",
    defaultBranch: "main",
    description: "TypeSpec API definition language skills for code generation and API design workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["api", "code-generation", "typescript", "openapi"],
  },
  {
    id: "microsoft-copilot-for-azure",
    name: "GitHub Copilot for Azure",
    repoUrl: "https://github.com/microsoft/GitHub-Copilot-for-Azure.git",
    defaultBranch: "main",
    description: "Azure-focused Copilot skills for cloud infrastructure, deployment, and resource management.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "high",
    focuses: ["azure", "cloud", "infrastructure", "deployment"],
  },
  {
    id: "microsoft-vscode-python-environments",
    name: "Microsoft VS Code Python Environments",
    repoUrl: "https://github.com/microsoft/vscode-python-environments.git",
    defaultBranch: "main",
    description: "Maintainer, reviewer, and documentation agents for a production VS Code extension.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["vscode", "python", "extension", "maintainer"],
  },
  {
    id: "microsoft-vscode-docs",
    name: "Microsoft VS Code Documentation",
    repoUrl: "https://github.com/microsoft/vscode-docs.git",
    defaultBranch: "main",
    description: "Skills for VS Code documentation authoring, editing, and review workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["documentation", "vscode", "markdown", "authoring"],
  },
  {
    id: "microsoft-windowsappsdk",
    name: "Microsoft Windows App SDK",
    repoUrl: "https://github.com/microsoft/WindowsAppSDK.git",
    defaultBranch: "main",
    description: "Windows App SDK skills for WinUI and Windows platform development.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["windows", "winui", "sdk", "desktop"],
  },
  {
    id: "microsoft-vscode-java-pack",
    name: "Microsoft VS Code Java Pack",
    repoUrl: "https://github.com/microsoft/vscode-java-pack.git",
    defaultBranch: "main",
    description: "Java development skills for VS Code including debugging, testing, and project management.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["java", "vscode", "debugging", "testing"],
  },
  {
    id: "microsoft-duroxide",
    name: "Microsoft Duroxide",
    repoUrl: "https://github.com/microsoft/duroxide.git",
    defaultBranch: "main",
    description: "Durable Functions in Rust — skills for building resilient serverless workflows.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["rust", "serverless", "durable-functions", "workflows"],
  },
  {
    id: "microsoft-ebpf-for-windows",
    name: "Microsoft eBPF for Windows",
    repoUrl: "https://github.com/microsoft/ebpf-for-windows.git",
    defaultBranch: "main",
    description: "eBPF development skills for Windows kernel and networking instrumentation.",
    owner: "microsoft",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["ebpf", "windows", "kernel", "networking"],
  },
  // ── GitHub — Official ─────────────────────────────────────────────────────
  {
    id: "github-copilot-sdk",
    name: "GitHub Copilot SDK",
    repoUrl: "https://github.com/github/copilot-sdk.git",
    defaultBranch: "main",
    description: "Official GitHub workflow-authoring and docs-maintenance agents for Copilot SDK projects.",
    owner: "github",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["copilot", "workflow", "docs"],
  },
  {
    id: "github-desktop",
    name: "GitHub Desktop",
    repoUrl: "https://github.com/desktop/desktop.git",
    defaultBranch: "development",
    description: "GitHub Desktop app agent profiles for Electron, TypeScript, and Git workflow development.",
    owner: "desktop",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["electron", "typescript", "git", "desktop"],
  },
  // ── Azure — Official ──────────────────────────────────────────────────────
  {
    id: "azure-sdk-for-js",
    name: "Azure SDK for JavaScript",
    repoUrl: "https://github.com/Azure/azure-sdk-for-js.git",
    defaultBranch: "main",
    description: "Azure JavaScript SDK repo with agentic workflow authoring guidance and prompts.",
    owner: "azure",
    trustTier: "official",
    importCoverage: "medium",
    focuses: ["azure", "javascript", "sdk", "workflow"],
  },
  // ── Community — Verified ──────────────────────────────────────────────────
  {
    id: "mastra-ai-mastra",
    name: "Mastra AI Framework",
    repoUrl: "https://github.com/mastra-ai/mastra.git",
    defaultBranch: "main",
    description: "AI agent framework with extensive prompt templates for issue tracking, code review, and workflow automation.",
    owner: "mastra-ai",
    trustTier: "community",
    importCoverage: "high",
    focuses: ["ai", "agents", "prompts", "automation"],
  },
  {
    id: "z3prover-z3",
    name: "Z3 Theorem Prover",
    repoUrl: "https://github.com/Z3Prover/z3.git",
    defaultBranch: "master",
    description: "Z3 SMT solver agent profiles for formal verification and constraint solving workflows.",
    owner: "Z3Prover",
    trustTier: "community",
    importCoverage: "low",
    focuses: ["formal-verification", "smt", "solver", "c++"],
  },
  {
    id: "likec4-likec4",
    name: "LikeC4",
    repoUrl: "https://github.com/likec4/likec4.git",
    defaultBranch: "main",
    description: "Architecture-as-code tool with agents for diagram generation and architecture documentation.",
    owner: "likec4",
    trustTier: "community",
    importCoverage: "medium",
    focuses: ["architecture", "diagrams", "documentation", "c4"],
  },
  {
    id: "canonical-copilot-collections",
    name: "Canonical Copilot Collections",
    repoUrl: "https://github.com/canonical/copilot-collections.git",
    defaultBranch: "main",
    description: "Canonical's curated collection of Copilot agent definitions for Ubuntu and open-source development.",
    owner: "canonical",
    trustTier: "community",
    importCoverage: "high",
    focuses: ["ubuntu", "linux", "open-source", "devops"],
  },
  {
    id: "playwright-mcp-prompts",
    name: "Playwright MCP Prompts",
    repoUrl: "https://github.com/debs-obrien/playwright-mcp-prompts.git",
    defaultBranch: "main",
    description: "Prompt templates for Playwright end-to-end testing, page objects, and test generation.",
    owner: "debs-obrien",
    trustTier: "community",
    importCoverage: "high",
    focuses: ["playwright", "testing", "e2e", "automation"],
  },
  {
    id: "copilot-prompts-collection",
    name: "GitHub Copilot Prompts",
    repoUrl: "https://github.com/raffertyuy/github-copilot-prompts.git",
    defaultBranch: "main",
    description: "Curated collection of GitHub Copilot prompt files for code review, refactoring, and documentation.",
    owner: "raffertyuy",
    trustTier: "community",
    importCoverage: "high",
    focuses: ["prompts", "code-review", "refactoring", "docs"],
  },
  {
    id: "copilot-kit",
    name: "Copilot Kit",
    repoUrl: "https://github.com/TheSethRose/Copilot-Kit.git",
    defaultBranch: "main",
    description: "Comprehensive Copilot customization kit with agent profiles, skills, and prompt templates.",
    owner: "TheSethRose",
    trustTier: "community",
    importCoverage: "high",
    focuses: ["copilot", "agents", "skills", "prompts"],
  },
  {
    id: "dataplat-dbatools",
    name: "dbatools",
    repoUrl: "https://github.com/dataplat/dbatools.git",
    defaultBranch: "development",
    description: "SQL Server and database administration prompts for DBA workflows and automation.",
    owner: "dataplat",
    trustTier: "community",
    importCoverage: "medium",
    focuses: ["sql-server", "database", "powershell", "administration"],
  },
  {
    id: "quran-frontend",
    name: "Quran.com Frontend",
    repoUrl: "https://github.com/quran/quran.com-frontend-next.git",
    defaultBranch: "master",
    description: "Next.js frontend agent profiles and prompts for internationalized web application development.",
    owner: "quran",
    trustTier: "community",
    importCoverage: "medium",
    focuses: ["nextjs", "react", "i18n", "frontend"],
  },
  {
    id: "finops-focus-spec",
    name: "FinOps FOCUS Spec",
    repoUrl: "https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec.git",
    defaultBranch: "working_draft",
    description: "FinOps specification prompts for cloud cost management and financial operations workflows.",
    owner: "FinOps-Open-Cost-and-Usage-Spec",
    trustTier: "community",
    importCoverage: "medium",
    focuses: ["finops", "cloud-costs", "specification", "governance"],
  },
]);

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeWellKnownSource(source = {}) {
  const repoUrl = String(source.repoUrl || "").trim();
  const github = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  const owner = String(source.owner || (github?.[1] || "")).trim();
  const repo = String(source.repo || (github?.[2] || "")).trim();
  return {
    ...source,
    owner: owner || null,
    repo: repo || null,
    provider: source.provider || (github ? "github" : null),
    importCoverage: String(source.importCoverage || "medium"),
    focuses: toStringArray(source.focuses),
  };
}

function compareWellKnownSources(a, b) {
  const delta = Number(b?.trust?.score || 0) - Number(a?.trust?.score || 0);
  if (delta !== 0) return delta;
  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

export function computeWellKnownSourceTrust(source, probe = {}, options = {}) {
  const nowMs = Number(options?.nowMs || Date.now());
  const normalized = normalizeWellKnownSource(source);
  const reasons = [];
  let score = 20;

  if (normalized.trustTier === "official") {
    score += 25;
    reasons.push("official-maintainer");
  }
  if (TRUSTED_GITHUB_OWNERS.has(String(normalized.owner || "").toLowerCase())) {
    score += 15;
    reasons.push("trusted-owner");
  }
  if (normalized.importCoverage === "high") {
    score += 12;
    reasons.push("high-import-coverage");
  } else if (normalized.importCoverage === "medium") {
    score += 6;
    reasons.push("import-coverage");
  }
  if (normalized.provider === "github") {
    score += 4;
    reasons.push("github-source");
  }

  const stars = Number(probe?.stars || 0);
  if (stars >= 10000) {
    score += 10;
    reasons.push("popular-repo");
  } else if (stars >= 1000) {
    score += 6;
    reasons.push("established-repo");
  } else if (stars >= 100) {
    score += 3;
  }

  const daysSincePush = Number.isFinite(probe?.daysSincePush)
    ? Number(probe.daysSincePush)
    : (probe?.pushedAt ? Math.max(0, (nowMs - Date.parse(probe.pushedAt)) / 86400000) : null);
  if (daysSincePush != null) {
    if (daysSincePush <= 45) {
      score += 10;
      reasons.push("recently-updated");
    } else if (daysSincePush <= 180) {
      score += 6;
      reasons.push("active-updates");
    } else if (daysSincePush <= 365) {
      score += 2;
    } else if (daysSincePush > 730) {
      score -= 16;
      reasons.push("stale-upstream");
    }
  }

  if (probe?.reachable === true) {
    score += 8;
    reasons.push("remote-reachable");
  } else if (probe?.reachable === false) {
    score -= 28;
    reasons.push("remote-unreachable");
  }

  if (probe?.branchExists === true) {
    score += 6;
    reasons.push("branch-ok");
  } else if (probe?.branchExists === false) {
    score -= 22;
    reasons.push("branch-missing");
  }

  if (probe?.archived === true) {
    score -= 45;
    reasons.push("archived");
  }
  if (probe?.disabled === true) {
    score -= 45;
    reasons.push("disabled");
  }

  score = Math.round(clampNumber(score, 0, 100));
  const enabled = score >= 55 && probe?.archived !== true && probe?.disabled !== true && probe?.reachable !== false && probe?.branchExists !== false;
  const status = !enabled ? "disabled" : score >= 85 ? "healthy" : score >= 65 ? "warning" : "degraded";

  return {
    score,
    status,
    enabled,
    reasons: uniqueStrings(reasons),
  };
}

function buildWellKnownSourceResult(source, probe = null, options = {}) {
  const normalized = normalizeWellKnownSource(source);
  const trust = computeWellKnownSourceTrust(normalized, probe || {}, options);
  return {
    ...normalized,
    trust,
    probe: probe ? { ...probe } : null,
    enabled: trust.enabled,
    status: trust.status,
  };
}

export function listWellKnownAgentSources() {
  return WELL_KNOWN_AGENT_SOURCES
    .map((source) => buildWellKnownSourceResult(source))
    .sort(compareWellKnownSources);
}

export function clearWellKnownAgentSourceProbeCache() {
  wellKnownSourceProbeCache.clear();
}

async function fetchGithubRepoProbe(source, options = {}) {
  const normalized = normalizeWellKnownSource(source);
  if (normalized.provider !== "github" || !normalized.owner || !normalized.repo) {
    return { checkedAt: nowISO(), reachable: false, branchExists: false, error: "Unsupported repository provider" };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || spawnSync;
  const branch = String(normalized.defaultBranch || "main").trim() || "main";
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "bosun-library-manager",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let repoMeta = null;
  let repoError = null;
  if (typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${normalized.owner}/${normalized.repo}`, { headers });
      if (response?.ok) {
        repoMeta = await response.json();
      } else {
        repoError = `GitHub API returned ${Number(response?.status || 0) || "error"}`;
      }
    } catch (err) {
      repoError = err?.message || String(err);
    }
  } else {
    repoError = "fetch unavailable";
  }

  let reachable = false;
  let branchExists = false;
  let gitError = null;
  try {
    const remote = spawnImpl("git", ["ls-remote", "--exit-code", "--heads", normalized.repoUrl, branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Number(options.timeoutMs || 15000),
    });
    const stdout = String(remote?.stdout || "").trim();
    reachable = Number(remote?.status) === 0 || stdout.length > 0;
    branchExists = reachable && stdout.length > 0;
    if (!reachable || !branchExists) {
      gitError = String(remote?.stderr || remote?.stdout || "git ls-remote failed").trim() || null;
    }
  } catch (err) {
    gitError = err?.message || String(err);
  }

  return {
    checkedAt: nowISO(),
    reachable,
    branchExists,
    defaultBranch: String(repoMeta?.default_branch || branch || "main"),
    archived: repoMeta?.archived === true,
    disabled: repoMeta?.disabled === true,
    stars: Number(repoMeta?.stargazers_count || 0),
    forks: Number(repoMeta?.forks_count || 0),
    openIssues: Number(repoMeta?.open_issues_count || 0),
    pushedAt: repoMeta?.pushed_at || null,
    daysSincePush: repoMeta?.pushed_at ? Math.max(0, Math.round((Date.now() - Date.parse(repoMeta.pushed_at)) / 86400000)) : null,
    apiReachable: Boolean(repoMeta),
    importReady: reachable && branchExists && repoMeta?.archived !== true && repoMeta?.disabled !== true,
    error: gitError || repoError || null,
  };
}

export async function probeWellKnownAgentSources(options = {}) {
  const nowMs = Number(options?.nowMs || Date.now());
  const ttlMs = Math.max(1000, Number(options?.ttlMs || 30 * 60 * 1000));
  const sourceId = String(options?.sourceId || "").trim().toLowerCase();
  const refresh = options?.refresh === true;
  const sources = WELL_KNOWN_AGENT_SOURCES.filter((source) => !sourceId || source.id === sourceId);
  const results = [];

  for (const source of sources) {
    const cacheKey = source.id;
    const cached = wellKnownSourceProbeCache.get(cacheKey) || null;
    if (!refresh && cached && (nowMs - Number(cached.cachedAt || 0)) < ttlMs) {
      results.push(buildWellKnownSourceResult(source, cached.probe, { nowMs }));
      continue;
    }

    const probe = await fetchGithubRepoProbe(source, options);
    wellKnownSourceProbeCache.set(cacheKey, { cachedAt: nowMs, probe });
    results.push(buildWellKnownSourceResult(source, probe, { nowMs }));
  }

  return results.sort(compareWellKnownSources);
}

function parseSimpleFrontmatter(markdown = "") {
  const text = String(markdown || "");
  if (!text.startsWith("---\n")) return { attrs: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { attrs: {}, body: text };
  const head = text.slice(4, end).split(/\r?\n/);
  const attrs = {};
  for (const line of head) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    attrs[m[1].trim()] = parseTomlValue(m[2]);
  }
  const body = text.slice(end + 5).trim();
  return { attrs, body };
}

function walkFilesRecursive(rootDir) {
  const stack = [rootDir];
  const files = [];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function ensureUniqueId(baseId, takenIds) {
  let id = baseId;
  let seq = 2;
  while (takenIds.has(id)) {
    id = `${baseId}-${seq}`;
    seq += 1;
  }
  takenIds.add(id);
  return id;
}

function getFrontmatterValue(attrs = {}, keys = []) {
  if (!attrs || typeof attrs !== "object") return null;
  for (const key of keys) {
    if (Object.hasOwn(attrs, key)) return attrs[key];
  }
  const lowerMap = new Map(
    Object.keys(attrs).map((key) => [String(key || "").toLowerCase(), attrs[key]]),
  );
  for (const key of keys) {
    const hit = lowerMap.get(String(key || "").toLowerCase());
    if (hit != null) return hit;
  }
  return null;
}

function normalizeImportedDescription(rawDescription, body = "") {
  const raw = String(rawDescription || "").trim();
  if (raw) {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1).trim();
    }
    return raw;
  }
  const fallback = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return String(fallback || "Imported library entry").trim();
}

function inferImportedEntryKind(relPath = "", fileName = "", attrs = {}) {
  const pathLower = String(relPath || "").toLowerCase();
  const fileLower = String(fileName || "").toLowerCase();
  const explicitType = String(getFrontmatterValue(attrs, ["type", "kind", "resourceType"]) || "").trim().toLowerCase();
  if (explicitType === "agent" || explicitType === "profile") return "agent";
  if (explicitType === "skill") return "skill";
  if (explicitType === "prompt") return "prompt";

  if (/\.agent\.md$/i.test(fileLower) || /\/\.github\/agents\//i.test(pathLower)) return "agent";
  if (
    fileLower === "skill.md"
    || /\.skill\.md$/i.test(fileLower)
    || /\/\.github\/skills\//i.test(pathLower)
    || /\/\.github\/plugins\/.*\/skills\//i.test(pathLower)
  ) return "skill";
  if (
    /\.prompt\.md$/i.test(fileLower)
    || /\/prompts\//i.test(pathLower)
    || /\/\.github\/prompts\//i.test(pathLower)
    || fileLower === "copilot-instructions.md"
  ) return "prompt";
  return null;
}
function humanizeSlug(slug) {
  const value = String(slug || "").trim();
  if (!value) return "";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function slugifyIdentifier(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return slugify(
    raw
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[_.]+/g, "-"),
  );
}

function parseTomlValue(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const body = raw.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(",")
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .map((part) => {
        if (
          (part.startsWith('"') && part.endsWith('"'))
          || (part.startsWith("'") && part.endsWith("'"))
        ) {
          return part.slice(1, -1);
        }
        return part;
      });
  }
  return raw;
}

function parseMcpServersFromToml(tomlText, sourcePath = "") {
  const servers = new Map();
  const lines = String(tomlText || "").split(/\r?\n/);
  let current = null;

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = String(sectionMatch[1] || "").trim();
      const mcpMatch = sectionName.match(/^mcp_servers\.([A-Za-z0-9_-]+)(?:\.(env))?$/i);
      if (!mcpMatch) {
        current = null;
        continue;
      }
      const rawId = String(mcpMatch[1] || "").trim();
      if (!rawId) {
        current = null;
        continue;
      }
      if (!servers.has(rawId)) {
        servers.set(rawId, {
          rawId,
          sourcePath,
          section: "mcp_servers." + rawId,
          main: {},
          envKeys: new Set(),
        });
      }
      current = {
        rawId,
        env: String(mcpMatch[2] || "").toLowerCase() === "env",
      };
      continue;
    }

    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;

    const key = String(kv[1] || "").trim();
    const value = parseTomlValue(kv[2]);
    if (!key) continue;

    const target = servers.get(current.rawId);
    if (!target) continue;
    if (current.env) {
      target.envKeys.add(key);
    } else {
      target.main[key] = value;
    }
  }

  const normalized = [];
  for (const record of servers.values()) {
    const id = slugifyIdentifier(record.rawId.replace(/_/g, "-"));
    if (!id) continue;

    const url = String(record.main.url || "").trim();
    const command = String(record.main.command || "").trim();
    const args = toStringArray(Array.isArray(record.main.args) ? record.main.args : []);
    const env = {};
    for (const key of record.envKeys) {
      env[key] = "";
    }

    if (!url && !command) continue;

    normalized.push({
      id,
      rawId: record.rawId,
      name: humanizeSlug(id),
      sourcePath: record.sourcePath,
      section: record.section,
      transport: url ? "url" : "stdio",
      url: url || null,
      command: command || null,
      args,
      env,
    });
  }

  return normalized;
}

function discoverLocalAgentTemplates(rootDir) {
  const candidateDirs = uniqueStrings([
    resolve(rootDir, ".github", "agents"),
    resolve(rootDir, "..", ".github", "agents"),
  ]);

  const templatesById = new Map();
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;

    let files = [];
    try {
      files = readdirSync(dir)
        .filter((name) => /\.md$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }

    for (const fileName of files) {
      const fullPath = resolve(dir, fileName);
      let body = "";
      try {
        body = String(readFileSync(fullPath, "utf8") || "");
      } catch {
        continue;
      }
      const content = body.trim();
      if (!content) continue;

      const baseName = basename(fileName, ".md").replace(/\.agent$/i, "");
      const id = slugifyIdentifier(baseName);
      if (!id || templatesById.has(id)) continue;

      const firstHeading = content.match(/^#\s+(.+)$/m);
      const name = firstHeading
        ? String(firstHeading[1] || "").trim()
        : humanizeSlug(id);
      const descriptionLine = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"));

      const relPathRaw = relative(rootDir, fullPath).replace(/\\/g, "/");
      const relPath = relPathRaw || ".github/agents/" + fileName;

      templatesById.set(id, {
        id,
        name: name || humanizeSlug(id),
        description: String(descriptionLine || ("Auto-synced prompt template from " + fileName)).slice(0, 240),
        relPath,
        content: body,
      });
    }
  }

  return [...templatesById.values()];
}

function discoverMcpServersFromCodexConfig(rootDir) {
  const candidates = uniqueStrings([
    resolve(rootDir, ".codex", "config.toml"),
    resolve(homedir(), ".codex", "config.toml"),
  ]);
  const discovered = [];
  const seenById = new Set();
  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    let raw = "";
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseMcpServersFromToml(raw, configPath);
    for (const entry of parsed) {
      if (!entry?.id || seenById.has(entry.id)) continue;
      seenById.add(entry.id);
      discovered.push(entry);
    }
  }
  return discovered;
}

/**
 * Auto-discover local prompt templates and MCP server definitions and sync
 * them into the library manifest/filesystem.
 */
export function syncAutoDiscoveredLibraryEntries(rootDir) {
  const root = rootDir || getBosunHomeDir();
  const manifestSnapshot = loadManifest(root);
  const existingEntries = Array.isArray(manifestSnapshot?.entries)
    ? manifestSnapshot.entries
    : [];
  const existingById = new Map(
    existingEntries
      .map((entry) => [String(entry?.id || "").trim(), entry])
      .filter(([id]) => Boolean(id)),
  );

  let promptEntriesUpserted = 0;
  let mcpEntriesUpserted = 0;
  let promptEntriesSkipped = 0;
  let mcpEntriesSkipped = 0;

  for (const template of discoverLocalAgentTemplates(root)) {
    const existing = existingById.get(template.id);
    const autoSyncMeta = existing?.meta?.autoSync || {};
    const canUpdateExisting =
      !existing
      || (existing.type === "prompt" && (
        String(autoSyncMeta.kind || "") === "local-agent-template"
        || template.id === "task-planner"
      ));

    if (!canUpdateExisting) {
      promptEntriesSkipped += 1;
      continue;
    }

    upsertEntry(root, {
      id: template.id,
      type: "prompt",
      name: template.name,
      description: template.description,
      tags: uniqueStrings([
        "prompt",
        "autodiscovered",
        "local-agent-template",
        template.id === "task-planner" ? "planner" : "",
      ]),
      meta: {
        autoSync: {
          kind: "local-agent-template",
          sourcePath: template.relPath,
          syncedAt: nowISO(),
        },
      },
    }, template.content);
    promptEntriesUpserted += 1;
  }

  for (const mcp of discoverMcpServersFromCodexConfig(root)) {
    const existing = existingById.get(mcp.id);
    const autoSyncMeta = existing?.meta?.autoSync || {};
    const canUpdateExisting =
      !existing
      || (existing.type === "mcp" && String(autoSyncMeta.kind || "") === "codex-mcp-config");

    if (!canUpdateExisting) {
      mcpEntriesSkipped += 1;
      continue;
    }

    const content = {
      id: mcp.id,
      name: mcp.name,
      description: "Auto-discovered from " + mcp.sourcePath,
      transport: mcp.transport,
      command: mcp.transport === "stdio" ? mcp.command : undefined,
      args: mcp.transport === "stdio" ? mcp.args : undefined,
      url: mcp.transport === "url" ? mcp.url : undefined,
      env: Object.keys(mcp.env || {}).length ? mcp.env : undefined,
      source: "autodiscovered",
      tags: ["autodiscovered", "codex-config", "mcp"],
    };

    upsertEntry(root, {
      id: mcp.id,
      type: "mcp",
      name: mcp.name,
      description: content.description,
      tags: uniqueStrings(["mcp", "autodiscovered", "codex-config"]),
      meta: {
        autoSync: {
          kind: "codex-mcp-config",
          sourcePath: mcp.sourcePath,
          section: mcp.section,
          rawId: mcp.rawId,
          syncedAt: nowISO(),
        },
      },
    }, content);
    mcpEntriesUpserted += 1;
  }

  return {
    promptEntriesUpserted,
    mcpEntriesUpserted,
    promptEntriesSkipped,
    mcpEntriesSkipped,
    totalUpserted: promptEntriesUpserted + mcpEntriesUpserted,
  };
}

export function scanRepositoryForImport(options = {}) {
  const sourceId = String(options?.sourceId || "").trim().toLowerCase();
  const known = WELL_KNOWN_AGENT_SOURCES.find((source) => source.id === sourceId) || null;
  const repoUrl = String(options?.repoUrl || known?.repoUrl || "").trim();
  if (!repoUrl) throw new Error("Repository URL or source is required");

  const branch = String(options?.branch || known?.defaultBranch || "main").trim() || "main";
  if (!isSafeGitRepositorySource(repoUrl)) {
    throw new Error("URL must be a valid http(s), ssh, or git repository address");
  }
  if (!isSafeGitRefName(branch)) {
    throw new Error("Branch name contains invalid characters");
  }
  const maxEntries = Math.max(
    1,
    Math.min(
      500,
      Number.parseInt(String(options?.maxEntries ?? "200"), 10) || 200,
    ),
  );

  const cacheRoot = ensureDir(resolve(getBosunHomeDir(), ".bosun", ".cache", "imports"));
  const checkoutDir = resolve(cacheRoot, `scan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  ensureDir(checkoutDir);

  const clone = spawnSync("git", ["clone", "--depth", "1", "--branch", branch, "--", repoUrl, checkoutDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (clone.status !== 0) {
    rmSync(checkoutDir, { recursive: true, force: true });
    const stderr = String(clone.stderr || "").trim();
    if (/repository not found/i.test(stderr)) {
      throw new Error(`Repository not found: ${repoUrl}`);
    }
    if (/could not read from remote/i.test(stderr)) {
      throw new Error(`Cannot access repository (may be private or require authentication): ${repoUrl}`);
    }
    if (/not found in upstream/i.test(stderr) || /remote branch.*not found/i.test(stderr)) {
      throw new Error(`Branch "${branch}" not found in ${repoUrl}`);
    }
    if (clone.signal === "SIGTERM") {
      throw new Error(`Clone timed out — repository may be too large: ${repoUrl}`);
    }
    throw new Error(`Failed to clone repository: ${stderr || "unknown error"}`);
  }

  try {
    const files = walkFilesRecursive(checkoutDir);
    const candidates = files
      .filter((fullPath) => /\.md$/i.test(fullPath))
      .map((fullPath) => {
        const relPath = fullPath.slice(checkoutDir.length + 1).replace(/\\/g, "/");
        const fileName = basename(fullPath);
        let parsed = { attrs: {}, body: "" };
        try {
          const raw = readFileSync(fullPath, "utf8");
          parsed = parseSimpleFrontmatter(raw);
        } catch { /* skip unreadable */ }
        const kind = inferImportedEntryKind(relPath, fileName, parsed.attrs);
        if (!kind) return null;
        const fileStem = basename(fileName, ".md");
        const relSegments = relPath.split(/[\\/]/).filter(Boolean);
        const parentSegment = relSegments.length > 1 ? relSegments[relSegments.length - 2] : "";
        const fallbackNameBase = fileStem.toLowerCase() === "skill" && parentSegment ? parentSegment : fileStem;
        const fallbackName = fallbackNameBase.replace(/\.agent$/i, "").replace(/\.skill$/i, "").replace(/\.prompt$/i, "");
        const name = String(getFrontmatterValue(parsed.attrs, ["name", "title"]) || fallbackName.replace(/[-_.]+/g, " ")).trim();
        const description = normalizeImportedDescription(getFrontmatterValue(parsed.attrs, ["description", "summary"]), parsed.body);
        return { relPath, fileName, kind, name, description, selected: true };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const rank = { agent: 0, prompt: 1, skill: 2 };
        const aRank = Number(rank[a.kind] ?? 99);
        const bRank = Number(rank[b.kind] ?? 99);
        if (aRank !== bRank) return aRank - bRank;
        return String(a.relPath || "").localeCompare(String(b.relPath || ""));
      })
      .slice(0, maxEntries);

    const byType = { agent: 0, prompt: 0, skill: 0 };
    for (const c of candidates) byType[c.kind] = (byType[c.kind] || 0) + 1;

    return {
      ok: true,
      source: known ? { id: known.id, name: known.name } : { id: sourceId || "custom", name: repoUrl },
      repoUrl,
      branch,
      totalCandidates: candidates.length,
      candidatesByType: byType,
      candidates,
    };
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
}

export function importAgentProfilesFromRepository(rootDir, options = {}) {
  const sourceId = String(options?.sourceId || "").trim().toLowerCase();
  const known = WELL_KNOWN_AGENT_SOURCES.find((source) => source.id === sourceId) || null;
  const repoUrl = String(options?.repoUrl || known?.repoUrl || "").trim();
  if (!repoUrl) throw new Error("Repository URL or source is required");

  const branch = String(options?.branch || known?.defaultBranch || "main").trim() || "main";
  if (!isSafeGitRepositorySource(repoUrl)) {
    throw new Error("URL must be a valid http(s), ssh, or git repository address");
  }
  if (!isSafeGitRefName(branch)) {
    throw new Error("Branch name contains invalid characters");
  }
  const maxProfiles = Math.max(
    1,
    Math.min(
      500,
      Number.parseInt(String(options?.maxEntries ?? options?.maxProfiles ?? "100"), 10) || 100,
    ),
  );
  const importAgents = options?.importAgents !== false;
  const importSkills = options?.importSkills !== false;
  const importPrompts = options?.importPrompts !== false;
  const importTools = options?.importTools !== false;
  const includeEntries = Array.isArray(options?.includeEntries) ? new Set(options.includeEntries.map((e) => String(e || "").trim()).filter(Boolean)) : null;

  const cacheRoot = ensureDir(resolve(rootDir || getBosunHomeDir(), ".bosun", ".cache", "imports"));
  const checkoutDir = resolve(cacheRoot, `import-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  ensureDir(checkoutDir);

  const clone = spawnSync("git", ["clone", "--depth", "1", "--branch", branch, "--", repoUrl, checkoutDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (clone.status !== 0) {
    rmSync(checkoutDir, { recursive: true, force: true });
    const stderr = String(clone.stderr || "").trim();
    if (/repository not found/i.test(stderr)) {
      throw new Error(`Repository not found: ${repoUrl}`);
    }
    if (/could not read from remote/i.test(stderr)) {
      throw new Error(`Cannot access repository (may be private or require authentication): ${repoUrl}`);
    }
    if (/not found in upstream/i.test(stderr) || /remote branch.*not found/i.test(stderr)) {
      throw new Error(`Branch "${branch}" not found in ${repoUrl}`);
    }
    if (clone.signal === "SIGTERM") {
      throw new Error(`Clone timed out — repository may be too large: ${repoUrl}`);
    }
    throw new Error(`Failed to clone repository: ${stderr || "unknown error"}`);
  }

  const files = walkFilesRecursive(checkoutDir);
  const markdownCandidates = files
    .filter((fullPath) => /\.md$/i.test(fullPath))
    .map((fullPath) => {
      const relPath = fullPath.slice(checkoutDir.length + 1).replace(/\\/g, "/");
      const fileName = basename(fullPath);
      const raw = readFileSync(fullPath, "utf8");
      const parsed = parseSimpleFrontmatter(raw);
      return {
        fullPath,
        relPath,
        fileName,
        raw,
        attrs: parsed.attrs,
        body: parsed.body,
        kind: inferImportedEntryKind(relPath, fileName, parsed.attrs),
      };
    })
    .filter((entry) => Boolean(entry.kind))
    .sort((a, b) => {
      const rank = { agent: 0, prompt: 1, skill: 2 };
      const aRank = Number(rank[a.kind] ?? 99);
      const bRank = Number(rank[b.kind] ?? 99);
      if (aRank !== bRank) return aRank - bRank;
      return String(a.relPath || "").localeCompare(String(b.relPath || ""));
    });

  const candidates = markdownCandidates.slice(0, maxProfiles);

  const takenIds = new Set(
    listEntries(rootDir).map((entry) => String(entry?.id || "").trim()).filter(Boolean),
  );
  const imported = [];
  const importedByType = { agent: 0, prompt: 0, skill: 0, mcp: 0 };
  let needsAgentIndexRefresh = false;
  let needsSkillIndexRefresh = false;

  try {
    for (const candidate of candidates) {
      const { attrs, body, relPath, fileName, kind } = candidate;
      if (includeEntries && !includeEntries.has(relPath)) continue;
      const fileStem = basename(fileName, ".md");
      const relSegments = relPath.split(/[\\/]/).filter(Boolean);
      const parentSegment = relSegments.length > 1 ? relSegments[relSegments.length - 2] : "";
      const fallbackNameBase = fileStem.toLowerCase() === "skill" && parentSegment ? parentSegment : fileStem;
      const fallbackName = fallbackNameBase.replace(/\.agent$/i, "").replace(/\.skill$/i, "").replace(/\.prompt$/i, "");
      const name = String(getFrontmatterValue(attrs, ["name", "title"]) || fallbackName.replace(/[-_.]+/g, " ")).trim();
      const description = normalizeImportedDescription(getFrontmatterValue(attrs, ["description", "summary"]), body);
      const keywords = keywordTokens(`${name} ${description} ${relPath}`, { minLength: 4 }).slice(0, 10);

      if (kind === "prompt") {
        if (!importPrompts) continue;
        const baseId = slugify(`${sourceId || "imported"}-${name}`) || slugify(fileStem) || `imported-prompt-${imported.length + 1}`;
        const id = ensureUniqueId(baseId, takenIds);
        const promptContent = String(body || candidate.raw || "").trim();
        if (!promptContent) continue;
        upsertEntry(rootDir, {
          id,
          type: "prompt",
          name,
          description: description || `Imported prompt from ${known?.name || repoUrl}`,
          tags: uniqueStrings(["imported", "prompt", sourceId || "external", ...parseJsonishArray(getFrontmatterValue(attrs, ["tags"]))]),
          meta: {
            sourceId: sourceId || null,
            repoUrl,
            branch,
            relPath,
          },
        }, promptContent);
        imported.push({ id, name, relPath, type: "prompt", promptId: null });
        importedByType.prompt += 1;
        continue;
      }

      if (kind === "skill") {
        if (!importSkills) continue;
        const baseId = slugify(`${sourceId || "imported"}-${name}`) || slugify(fileStem) || `imported-skill-${imported.length + 1}`;
        const id = ensureUniqueId(baseId, takenIds);
        const skillContent = String(body || candidate.raw || "").trim();
        if (!skillContent) continue;
        upsertEntry(rootDir, {
          id,
          type: "skill",
          name,
          description: description || "Imported skill",
          tags: uniqueStrings(["imported", "skill", sourceId || "external", ...parseJsonishArray(getFrontmatterValue(attrs, ["tags"]))]),
          meta: {
            sourceId: sourceId || null,
            repoUrl,
            branch,
            relPath,
          },
        }, skillContent, { skipIndexSync: true });
        imported.push({ id, name, relPath, type: "skill", promptId: null });
        importedByType.skill += 1;
        needsSkillIndexRefresh = true;
        continue;
      }

      if (kind !== "agent" || !importAgents) continue;

      const baseId = slugify(`${sourceId || "imported"}-${name}`) || slugify(fileStem) || `imported-agent-${imported.length + 1}`;
      const id = ensureUniqueId(baseId, takenIds);
      const toolHints = parseJsonishArray(getFrontmatterValue(attrs, ["tools", "enabledTools"]));
      const profileSkillHints = parseJsonishArray(getFrontmatterValue(attrs, ["skills"]));
      const mcpHints = parseJsonishArray(getFrontmatterValue(attrs, ["enabledMcpServers", "mcpServers", "mcp"]));
      const titlePatternHints = parseJsonishArray(getFrontmatterValue(attrs, ["titlePatterns", "title_patterns", "patterns"]));
      const tags = uniqueStrings([
        "imported",
        sourceId || "external",
        ...parseJsonishArray(getFrontmatterValue(attrs, ["tags"])),
        ...keywords.slice(0, 4),
      ]);
      const pathScopes = uniqueStrings(
        relPath
          .split(/[\\/]/)
          .slice(0, -1)
          .map((segment) => slugify(segment))
          .filter((segment) => segment && segment !== "github" && segment !== "agents"),
      ).slice(0, 6);
      const explicitScopes = parseJsonishArray(getFrontmatterValue(attrs, ["scopes", "scope"]));
      const scopes = uniqueStrings([...explicitScopes, ...pathScopes]).slice(0, 8);
      const titlePatterns = uniqueStrings([
        ...titlePatternHints,
        ...keywordTokens(name, { minLength: 4 }).slice(0, 4).map((token) => `\\b${token.replace(/[.*+?^${}()|[\\]\\]/g, "")}\\b`),
      ]);
      const promptId = `${id}-prompt`;

      if (importPrompts && body) {
        upsertEntry(rootDir, {
          id: promptId,
          type: "prompt",
          name: `${name} Prompt`,
          description: `Imported prompt from ${known?.name || repoUrl}`,
          tags: uniqueStrings(["imported", "agent-prompt", sourceId || "external"]),
          meta: {
            sourceId: sourceId || null,
            repoUrl,
            branch,
            relPath,
          },
        }, body);
        imported.push({ id: promptId, name: `${name} Prompt`, relPath, type: "prompt", promptId: null });
        importedByType.prompt += 1;
      }

      const explicitAgentType = String(getFrontmatterValue(attrs, ["agentType", "agent_type"]) || "").trim().toLowerCase();
      const profile = {
        id,
        name,
        description,
        titlePatterns: titlePatterns.length ? titlePatterns : ["\\btask\\b"],
        scopes,
        sdk: null,
        model: null,
        promptOverride: importPrompts && body ? promptId : null,
        skills: profileSkillHints,
        hookProfile: null,
        env: {},
        enabledTools: toolHints.length ? toolHints : null,
        enabledMcpServers: mcpHints,
        tags,
        agentType: explicitAgentType || (/voice|audio|realtime/i.test(`${name} ${description}`) ? "voice" : "task"),
        importMeta: {
          sourceId: sourceId || null,
          repoUrl,
          branch,
          relPath,
        },
      };

      upsertEntry(rootDir, {
        id,
        type: "agent",
        name,
        description,
        tags: profile.tags,
        meta: {
          sourceId: sourceId || null,
          repoUrl,
          branch,
          relPath,
        },
      }, profile, { skipIndexSync: true });

      imported.push({ id, name, relPath, type: "agent", promptId: importPrompts && body ? promptId : null });
      importedByType.agent += 1;
      needsAgentIndexRefresh = true;
    }

    if (importTools) {
      const mcpCandidates = uniqueStrings([
        resolve(checkoutDir, ".codex", "config.toml"),
      ]);
      for (const configPath of mcpCandidates) {
        if (!existsSync(configPath)) continue;
        let raw = "";
        try {
          raw = readFileSync(configPath, "utf8");
        } catch {
          continue;
        }
        const relPath = relative(checkoutDir, configPath).replace(/\\/g, "/");
        const discovered = parseMcpServersFromToml(raw, relPath);
        for (const mcp of discovered) {
          const baseId = slugify(`${sourceId || "imported"}-${mcp.id}`) || slugify(mcp.id) || `imported-mcp-${imported.length + 1}`;
          const id = ensureUniqueId(baseId, takenIds);
          const content = {
            id,
            name: mcp.name,
            description: "Imported MCP server definition from " + relPath,
            transport: mcp.transport,
            command: mcp.transport === "stdio" ? mcp.command : undefined,
            args: mcp.transport === "stdio" ? mcp.args : undefined,
            url: mcp.transport === "url" ? mcp.url : undefined,
            env: Object.keys(mcp.env || {}).length ? mcp.env : undefined,
            source: "imported",
            tags: ["imported", "mcp", sourceId || "external"],
          };
          upsertEntry(rootDir, {
            id,
            type: "mcp",
            name: mcp.name,
            description: content.description,
            tags: uniqueStrings(["imported", "mcp", sourceId || "external"]),
            meta: {
              sourceId: sourceId || null,
              repoUrl,
              branch,
              relPath,
            },
          }, content);
          imported.push({ id, name: mcp.name, relPath, type: "mcp", promptId: null });
          importedByType.mcp += 1;
        }
      }
    }
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }

  if (needsAgentIndexRefresh) rebuildAgentProfileIndex(rootDir);
  if (needsSkillIndexRefresh) rebuildSkillEntryIndex(rootDir);

  return {
    ok: true,
    source: known ? { ...known } : { id: sourceId || "custom", repoUrl, defaultBranch: branch },
    repoUrl,
    branch,
    importedCount: imported.length,
    importedByType,
    imported,
  };
}

// ── Scope Auto-Detection ─────────────────────────────────────────────────────

/**
 * Auto-detect available scopes for a repository by scanning:
 * 1. Git commit history (conventional commit scopes)
 * 2. Top-level folder structure
 *
 * @param {string} repoRoot - repository root path
 * @param {{ maxCommits?: number }} [opts]
 * @returns {{ scopes: Array<{ name: string, source: string, count?: number }> }}
 */
export function detectScopes(repoRoot, opts = {}) {
  const { maxCommits = 200 } = opts;
  const scopes = new Map(); // name → { source, count }

  // 1. Scan git commit history for conventional commit scopes
  try {
    const gitEnv = { ...process.env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    delete gitEnv.GIT_INDEX_FILE;
    delete gitEnv.GIT_COMMON_DIR;
    delete gitEnv.GIT_PREFIX;
    const safeMaxCommits = Math.max(1, Math.min(5000, Number.parseInt(String(maxCommits), 10) || 200));
    const logResult = spawnSync(
      "git",
      ["log", "--oneline", "-" + safeMaxCommits, "--format=%s"],
      {
        cwd: repoRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (logResult.error) throw logResult.error;
    if (logResult.status !== 0) {
      throw new Error(String(logResult.stderr || logResult.stdout || "git log failed").trim());
    }
    const log = String(logResult.stdout || "");
    const scopeRegex = /(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/gi;
    for (const line of log.split("\n")) {
      let m;
      while ((m = scopeRegex.exec(line)) !== null) {
        const name = m[1].toLowerCase().trim();
        if (!name) continue;
        const existing = scopes.get(name);
        if (existing) {
          existing.count++;
        } else {
          scopes.set(name, { name, source: "git", count: 1 });
        }
      }
    }
  } catch {
    // git not available or not a repo – skip
  }

  // 2. Scan top-level folders
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      // Skip common non-scope directories
      if (/^(\.|node_modules|dist|build|out|coverage|__pycache__|\.git)$/.test(name)) continue;
      if (!scopes.has(name)) {
        scopes.set(name, { name, source: "folder", count: 0 });
      } else {
        // If already from git, mark as both
        const existing = scopes.get(name);
        if (existing.source === "git") existing.source = "git+folder";
      }
    }
  } catch {
    // can't read directory
  }

  // Sort: git scopes first (by count desc), then folder scopes alphabetically
  const result = [...scopes.values()].sort((a, b) => {
    if (a.source.startsWith("git") && !b.source.startsWith("git")) return -1;
    if (!a.source.startsWith("git") && b.source.startsWith("git")) return 1;
    if (a.count !== b.count) return (b.count || 0) - (a.count || 0);
    return a.name.localeCompare(b.name);
  });

  return { scopes: result };
}

// ── Namespaced Reference Resolution ──────────────────────────────────────────

/**
 * Resolve `{{prompt:name}}`, `{{agent:name}}`, `{{skill:name}}` references
 * within a template string.
 *
 * @param {string} template     - template string with `{{type:name}}` placeholders
 * @param {string} rootDir      - workspace/bosun home root
 * @param {Object} [extraVars]  - additional simple `{{KEY}}` variables
 * @returns {string}
 */
export function resolveLibraryRefs(template, rootDir, extraVars = {}) {
  if (typeof template !== "string") return "";

  // First resolve namespaced refs: {{prompt:name}}, {{agent:name}}, {{skill:name}}, {{mcp:name}}
  let resolved = template.replace(
    /\{\{\s*(prompt|agent|skill|mcp):([A-Za-z0-9_-]+)\s*\}\}/gi,
    (_full, type, name) => {
      const typeLower = type.toLowerCase();
      const id = slugify(name);
      const entry = getEntry(rootDir, id);
      if (!entry || entry.type !== typeLower) {
        // Try a fuzzy lookup by name
        const entries = listEntries(rootDir, { type: typeLower });
        const byName = entries.find(
          (e) => e.id === id || slugify(e.name) === id || e.name.toLowerCase() === name.toLowerCase(),
        );
        if (byName) {
          const content = getEntryContent(rootDir, byName);
          if (content) return typeof content === "object" ? JSON.stringify(content) : content;
        }
        return `<!-- [library:${typeLower}:${name} not found] -->`;
      }
      const content = getEntryContent(rootDir, entry);
      if (!content) return `<!-- [library:${typeLower}:${name} empty] -->`;
      return typeof content === "object" ? JSON.stringify(content) : content;
    },
  );

  // Then resolve simple {{KEY}} variables
  if (extraVars && Object.keys(extraVars).length) {
    const normalized = {};
    for (const [k, v] of Object.entries(extraVars)) {
      normalized[String(k).trim().toUpperCase()] = v == null ? "" : String(v);
    }
    resolved = resolved.replace(
      /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
      (full, key) => {
        const hit = normalized[String(key).toUpperCase()];
        return hit != null ? hit : full; // Keep unresolved simple vars as-is
      },
    );
  }

  return resolved;
}

// ── Manifest Rebuild / Sync ──────────────────────────────────────────────────

/**
 * Rebuild the manifest by scanning the actual directories for files.
 * Merges with existing manifest data to preserve metadata.
 *
 * @param {string} rootDir
 * @returns {{ entries: LibraryEntry[], added: number, removed: number }}
 */
export function rebuildManifest(rootDir) {
  const existing = loadManifest(rootDir);
  const existingById = new Map(existing.entries.map((e) => [e.id, e]));
  const newEntries = [];
  let added = 0;
  let removed = 0;

  for (const type of RESOURCE_TYPES) {
    // custom-tool entries are self-managed by agent-custom-tools.mjs
    // (see TOOL_DIR / tools/index.json) — skip here to avoid double-indexing
    if (type === "custom-tool") continue;

    const dir = dirForType(rootDir, type);
    if (!existsSync(dir)) continue;

    const ext = extForType(type);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(ext));
    } catch { continue; }

    for (const filename of files) {
      const filePath = resolve(dir, filename);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }

      // Derive id from filename
      const id = slugify(basename(filename, ext));
      const existing = existingById.get(id);

      if (existing && existing.type === type) {
        // Keep existing metadata, update timestamp
        newEntries.push({ ...existing, updatedAt: stat.mtime.toISOString() });
        existingById.delete(id);
      } else {
        // New file not in manifest
        let name = basename(filename, ext)
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        let description = "";
        let tags = [];

        // Try to extract metadata from file content
        try {
          const content = readFileSync(filePath, "utf8");
          if (type === "agent") {
            const parsed = JSON.parse(content);
            name = parsed.name || name;
            description = parsed.description || "";
            tags = parsed.tags || [];
          } else {
            // Markdown: extract title from first heading
            const h1 = /^#\s+(?:Skill:\s*)?(.+)/m.exec(content);
            if (h1) name = h1[1].trim();
            // Extract tags from comment
            const tagMatch = /<!--\s*tags:\s*(.+?)\s*-->/i.exec(content);
            if (tagMatch) {
              tags = tagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
            }
            // Extract description from first paragraph after heading
            const descMatch = /^#.+\n+(?:>\s*)?(.+)/m.exec(content);
            if (descMatch) description = descMatch[1].trim().slice(0, 200);
          }
        } catch { /* ignore parse errors */ }

        newEntries.push({
          id,
          type,
          name,
          description,
          filename,
          tags,
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: stat.birthtime?.toISOString?.() || nowISO(),
          updatedAt: stat.mtime.toISOString(),
        });
        added++;
      }
    }
  }

  // Entries left in existingById were not found on disk → removed
  removed = existingById.size;

  const manifest = { entries: newEntries, generated: nowISO() };
  saveManifest(rootDir, manifest);
  rebuildAgentProfileIndex(rootDir, manifest);
  rebuildSkillEntryIndex(rootDir, manifest);

  return { entries: newEntries, added, removed };
}

// ── Multi-Workspace Resolution Chain ─────────────────────────────────────────

/**
 * Resolve a library reference across the workspace chain:
 *   1. Workspace-local (.bosun/ under workspace root)
 *   2. Global (BOSUN_HOME/.bosun/)
 *
 * @param {string} workspaceRoot
 * @param {string} id
 * @returns {{ entry: LibraryEntry|null, content: string|Object|null, source: string }}
 */
export function resolveEntry(workspaceRoot, id) {
  // 1. Check workspace-local
  if (workspaceRoot) {
    const entry = getEntry(workspaceRoot, id);
    if (entry) {
      const content = getEntryContent(workspaceRoot, entry);
      if (content) return { entry, content, source: "workspace" };
    }
  }

  // 2. Check global
  const globalRoot = getBosunHomeDir();
  if (globalRoot !== workspaceRoot) {
    const entry = getEntry(globalRoot, id);
    if (entry) {
      const content = getEntryContent(globalRoot, entry);
      if (content) return { entry, content, source: "global" };
    }
  }

  return { entry: null, content: null, source: "none" };
}

// ── Built-in Agent Profile Templates ─────────────────────────────────────────

export const BUILTIN_AGENT_PROFILES = [
  {
    id: "ui-agent",
    name: "UI Agent",
    description: "Front-end specialist for portal and UI tasks. Auto-selected for feat(portal), feat(ui), fix(portal) tasks.",
    titlePatterns: ["\\(portal\\)", "\\(ui\\)", "\\(frontend\\)", "\\(web\\)", "\\(css\\)", "\\bUI\\b", "\\bfrontend\\b"],
    scopes: ["portal", "ui", "frontend", "web", "css"],
    sdk: null,
    model: null,
    promptOverride: "frontend-agent",
    skills: ["frontend-patterns"],
    hookProfile: null,
    env: {},
    tags: ["ui", "frontend", "portal", "css", "web"],
    agentType: "task",
  },
  {
    id: "backend-agent",
    name: "Backend Agent",
    description: "Backend/API specialist. Auto-selected for feat(api), feat(server), feat(db) tasks.",
    titlePatterns: ["\\(api\\)", "\\(server\\)", "\\(db\\)", "\\(backend\\)", "\\bAPI\\b", "\\bserver\\b"],
    scopes: ["api", "server", "db", "backend"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["background-task-execution"],
    hookProfile: null,
    env: {},
    tags: ["api", "server", "backend", "database"],
    agentType: "task",
  },
  {
    id: "devops-agent",
    name: "DevOps Agent",
    description: "CI/CD and infrastructure specialist. Auto-selected for ci(), build(), infra() tasks.",
    titlePatterns: ["\\(ci\\)", "\\(cd\\)", "\\(build\\)", "\\(infra\\)", "\\(deploy\\)", "\\bCI\\b", "\\bCD\\b", "\\bpipeline\\b"],
    scopes: ["ci", "cd", "build", "infra", "deploy"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["ci", "cd", "build", "deploy", "infra", "devops"],
    agentType: "task",
  },
  {
    id: "docs-agent",
    name: "Docs Agent",
    description: "Documentation specialist. Auto-selected for docs() tasks.",
    titlePatterns: ["\\(docs\\)", "\\(readme\\)", "\\bdocumentation\\b", "\\bREADME\\b", "\\baudit\\b", "\\bannotat"],
    scopes: ["docs", "readme", "audit"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["codebase-annotation-audit"],
    hookProfile: null,
    env: {},
    tags: ["docs", "documentation", "readme", "markdown", "audit", "annotation"],
    agentType: "task",
  },
  {
    id: "test-agent",
    name: "Test Agent",
    description: "Testing specialist. Auto-selected for test() tasks.",
    titlePatterns: ["\\(test\\)", "\\(tests\\)", "\\(e2e\\)", "\\(unit\\)", "\\btesting\\b"],
    scopes: ["test", "tests", "e2e", "unit"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["test", "testing", "e2e", "unit", "coverage"],
    agentType: "task",
  },
  {
    id: "voice-agent-female",
    name: "Voice Agent (Female)",
    description: "Conversational voice specialist with concise guidance and call-friendly pacing.",
    titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
    scopes: ["voice", "assistant"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["concise-voice-guidance", "conversation-memory"],
    hookProfile: null,
    env: {},
    tags: ["voice", "assistant", "realtime", "female", "default", "audio-agent"],
    agentType: "voice",
    voiceAgent: true,
    voicePersona: "female",
    voiceInstructions: "You are Nova, a female voice agent. Be concise, warm, and practical. Use tools for facts and execution. Keep spoken responses short and clear.",
    enabledTools: null,
    enabledMcpServers: [],
  },
  {
    id: "voice-agent-male",
    name: "Voice Agent (Male)",
    description: "Operational voice specialist focused on diagnostics and execution.",
    titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
    scopes: ["voice", "assistant"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["ops-diagnostics", "task-execution"],
    hookProfile: null,
    env: {},
    tags: ["voice", "assistant", "realtime", "male", "default", "audio-agent"],
    agentType: "voice",
    voiceAgent: true,
    voicePersona: "male",
    voiceInstructions: "You are Atlas, a male voice agent. Be direct and execution-oriented. Prefer actionable status updates. Use tools proactively for diagnostics.",
    enabledTools: null,
    enabledMcpServers: [],
  },
  {
    id: "voice-agent",
    name: "Voice Agent",
    description: "Default voice assistant agent. Handles real-time voice sessions, tool calls, and delegate orchestration. Customize tools and MCP servers for voice interactions.",
    titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
    scopes: ["voice", "assistant"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["voice", "assistant", "realtime", "default"],
    agentType: "voice",
    voiceAgent: true,
    voicePersona: "neutral",
    enabledTools: null,
    enabledMcpServers: [],
  },
];

/**
 * Scaffold built-in agent profiles into the profiles directory.
 * Does not overwrite existing profiles.
 *
 * @param {string} rootDir
 * @returns {{ written: string[], skipped: string[] }}
 */
export function scaffoldAgentProfiles(rootDir) {
  const dir = ensureDir(dirForType(rootDir, "agent"));
  const written = [];
  const skipped = [];

  for (const profile of BUILTIN_AGENT_PROFILES) {
    const filePath = resolve(dir, `${profile.id}.json`);
    if (existsSync(filePath)) {
      skipped.push(filePath);
      continue;
    }
    writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n", "utf8");
    written.push(filePath);
  }

  return { written, skipped };
}

/**
 * Initialize the full library for a root directory.
 * Scaffolds profiles, rebuilds manifest.
 *
 * @param {string} rootDir
 * @returns {{ manifest: Object, scaffolded: Object }}
 */
export function initLibrary(rootDir) {
  const scaffolded = scaffoldAgentProfiles(rootDir);
  const manifest = rebuildManifest(rootDir);
  const autoSynced = syncAutoDiscoveredLibraryEntries(rootDir);
  const latestManifest = loadManifest(rootDir);
  return {
    manifest: latestManifest?.entries ? latestManifest : manifest,
    scaffolded,
    autoSynced,
  };
}
