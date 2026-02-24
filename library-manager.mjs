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
import { resolve, basename, join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

// ── Constants ─────────────────────────────────────────────────────────────────

export const LIBRARY_MANIFEST = "library.json";
export const PROMPT_DIR = ".bosun/agents";
export const SKILL_DIR = ".bosun/skills";
export const PROFILE_DIR = ".bosun/profiles";

/** Resource types managed by the library */
export const RESOURCE_TYPES = Object.freeze(["prompt", "agent", "skill"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBosunHome() {
  return (
    process.env.BOSUN_HOME ||
    process.env.BOSUN_DIR ||
    resolve(homedir(), ".bosun")
  );
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
 */

/**
 * Get the manifest path for a workspace (or global).
 */
export function getManifestPath(rootDir) {
  return resolve(rootDir || getBosunHome(), ".bosun", LIBRARY_MANIFEST);
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
  const root = rootDir || getBosunHome();
  switch (type) {
    case "prompt": return resolve(root, PROMPT_DIR);
    case "skill":  return resolve(root, SKILL_DIR);
    case "agent":  return resolve(root, PROFILE_DIR);
    default: throw new Error(`Unknown library resource type: ${type}`);
  }
}

function extForType(type) {
  return type === "agent" ? ".json" : ".md";
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
    return entry.type === "agent" ? JSON.parse(raw) : raw;
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
export function upsertEntry(rootDir, data, content) {
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

  return entry;
}

/**
 * Delete a library entry by id. Removes from manifest (optionally deletes file).
 */
export function deleteEntry(rootDir, id, { deleteFile = false } = {}) {
  const manifest = loadManifest(rootDir);
  const idx = manifest.entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;

  const entry = manifest.entries[idx];
  manifest.entries.splice(idx, 1);
  saveManifest(rootDir, manifest);

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
export function matchAgentProfile(rootDir, taskTitle) {
  if (!taskTitle) return null;
  const profiles = listAgentProfiles(rootDir);
  const titleLower = taskTitle.toLowerCase();

  // Extract scope from task title using conventional commit format
  const scopeMatch = taskTitle.match(
    /(?:^\[[^\]]+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  const taskScope = scopeMatch ? scopeMatch[1].toLowerCase().trim() : null;

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of profiles) {
    const profile = entry.profile;
    if (!profile) continue;

    let score = 0;

    // Check title patterns (regex match)
    const patterns = profile.titlePatterns || [];
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, "i").test(taskTitle)) {
          score += 10;
          break;
        }
      } catch { /* invalid regex – skip */ }
    }

    // Check scope match
    const scopes = (profile.scopes || []).map((s) => s.toLowerCase());
    if (taskScope && scopes.includes(taskScope)) {
      score += 5;
    }

    // Check tag match against title
    const tags = entry.tags || [];
    for (const tag of tags) {
      if (titleLower.includes(tag)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { ...entry, score };
    }
  }

  return bestMatch;
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
    const log = execSync(
      `git log --oneline -${maxCommits} --format="%s"`,
      { cwd: repoRoot, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    );
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

  // First resolve namespaced refs: {{prompt:name}}, {{agent:name}}, {{skill:name}}
  let resolved = template.replace(
    /\{\{\s*(prompt|agent|skill):([A-Za-z0-9_-]+)\s*\}\}/gi,
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
  const globalRoot = getBosunHome();
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
  },
  {
    id: "docs-agent",
    name: "Docs Agent",
    description: "Documentation specialist. Auto-selected for docs() tasks.",
    titlePatterns: ["\\(docs\\)", "\\(readme\\)", "\\bdocumentation\\b", "\\bREADME\\b"],
    scopes: ["docs", "readme"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["docs", "documentation", "readme", "markdown"],
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
  return { manifest, scaffolded };
}
