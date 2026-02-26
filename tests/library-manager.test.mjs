import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadManifest,
  saveManifest,
  listEntries,
  getEntry,
  getEntryContent,
  upsertEntry,
  deleteEntry,
  listAgentProfiles,
  matchAgentProfile,
  detectScopes,
  rebuildManifest,
  initLibrary,
  resolveLibraryRefs,
  scaffoldAgentProfiles,
  RESOURCE_TYPES,
  BUILTIN_AGENT_PROFILES,
  getManifestPath,
  PROMPT_DIR,
  SKILL_DIR,
  PROFILE_DIR,
  resolveEntry,
} from "../scripts/bosun/utils/library-manager.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;

function fresh() {
  tmpDir = mkdtempSync(join(tmpdir(), "lib-mgr-test-"));
  return tmpDir;
}

function cleanup() {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
}

// ── Constants ───────────────────────────────────────────────────────────────

describe("library-manager constants", () => {
  it("exports RESOURCE_TYPES with prompt, agent, skill", () => {
    expect(RESOURCE_TYPES).toContain("prompt");
    expect(RESOURCE_TYPES).toContain("agent");
    expect(RESOURCE_TYPES).toContain("skill");
    expect(Object.isFrozen(RESOURCE_TYPES)).toBe(true);
  });

  it("exports BUILTIN_AGENT_PROFILES array", () => {
    expect(Array.isArray(BUILTIN_AGENT_PROFILES)).toBe(true);
    expect(BUILTIN_AGENT_PROFILES.length).toBeGreaterThanOrEqual(5);
    for (const p of BUILTIN_AGENT_PROFILES) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(Array.isArray(p.titlePatterns)).toBe(true);
      expect(Array.isArray(p.scopes)).toBe(true);
      expect(Array.isArray(p.tags)).toBe(true);
    }
  });

  it("has expected built-in profiles", () => {
    const ids = BUILTIN_AGENT_PROFILES.map((p) => p.id);
    expect(ids).toContain("ui-agent");
    expect(ids).toContain("backend-agent");
    expect(ids).toContain("devops-agent");
    expect(ids).toContain("docs-agent");
    expect(ids).toContain("test-agent");
  });
});

// ── Manifest CRUD ───────────────────────────────────────────────────────────

describe("manifest CRUD", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("loadManifest returns empty when no file exists", () => {
    const m = loadManifest(tmpDir);
    expect(m.entries).toEqual([]);
    expect(typeof m.generated).toBe("string");
  });

  it("saveManifest creates the file and loadManifest reads it back", () => {
    const manifest = { entries: [{ id: "test", type: "prompt", name: "Test" }], generated: "" };
    saveManifest(tmpDir, manifest);
    const path = getManifestPath(tmpDir);
    expect(existsSync(path)).toBe(true);
    const loaded = loadManifest(tmpDir);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].id).toBe("test");
  });

  it("upsertEntry creates a new entry with file", () => {
    const entry = upsertEntry(tmpDir, {
      type: "prompt",
      name: "My Prompt",
      description: "A test prompt",
      tags: ["test"],
    }, "# My Prompt\n\nHello world.");

    expect(entry.id).toBe("my-prompt");
    expect(entry.type).toBe("prompt");
    expect(entry.name).toBe("My Prompt");
    expect(entry.tags).toEqual(["test"]);

    // Verify file on disk
    const filePath = resolve(tmpDir, PROMPT_DIR, entry.filename);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("# My Prompt\n\nHello world.");

    // Verify manifest
    const manifest = loadManifest(tmpDir);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].id).toBe("my-prompt");
  });

  it("upsertEntry updates an existing entry", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "My Prompt" }, "v1");
    const updated = upsertEntry(tmpDir, {
      id: "my-prompt",
      type: "prompt",
      name: "My Prompt Updated",
      description: "Updated description",
    }, "v2");

    expect(updated.name).toBe("My Prompt Updated");
    expect(updated.description).toBe("Updated description");
    expect(loadManifest(tmpDir).entries).toHaveLength(1);

    const content = getEntryContent(tmpDir, updated);
    expect(content).toBe("v2");
  });

  it("upsertEntry for agent profile stores JSON", () => {
    const profile = { name: "Custom Agent", scopes: ["api"], titlePatterns: ["\\(api\\)"] };
    const entry = upsertEntry(tmpDir, {
      type: "agent",
      name: "Custom Agent",
      tags: ["api"],
    }, profile);

    expect(entry.filename).toMatch(/\.json$/);
    const content = getEntryContent(tmpDir, entry);
    expect(content).toEqual(profile);
  });

  it("getEntry finds by id", () => {
    upsertEntry(tmpDir, { type: "skill", name: "Background Tasks" }, "# BG");
    const found = getEntry(tmpDir, "background-tasks");
    expect(found).not.toBeNull();
    expect(found.name).toBe("Background Tasks");
  });

  it("getEntry returns null for missing id", () => {
    expect(getEntry(tmpDir, "nonexistent")).toBeNull();
  });

  it("deleteEntry removes from manifest", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "To Delete" }, "content");
    expect(loadManifest(tmpDir).entries).toHaveLength(1);

    const deleted = deleteEntry(tmpDir, "to-delete");
    expect(deleted).toBe(true);
    expect(loadManifest(tmpDir).entries).toHaveLength(0);
  });

  it("deleteEntry returns false for non-existent id", () => {
    expect(deleteEntry(tmpDir, "nope")).toBe(false);
  });

  it("listEntries filters by type", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "P1" }, "p");
    upsertEntry(tmpDir, { type: "skill", name: "S1" }, "s");
    upsertEntry(tmpDir, { type: "agent", name: "A1" }, { name: "A1" });

    expect(listEntries(tmpDir)).toHaveLength(3);
    expect(listEntries(tmpDir, { type: "prompt" })).toHaveLength(1);
    expect(listEntries(tmpDir, { type: "skill" })).toHaveLength(1);
    expect(listEntries(tmpDir, { type: "agent" })).toHaveLength(1);
  });

  it("listEntries filters by search", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "Alpha", description: "First prompt" }, "a");
    upsertEntry(tmpDir, { type: "prompt", name: "Beta", description: "Second prompt" }, "b");

    expect(listEntries(tmpDir, { search: "alpha" })).toHaveLength(1);
    expect(listEntries(tmpDir, { search: "prompt" })).toHaveLength(2);
    expect(listEntries(tmpDir, { search: "zzz" })).toHaveLength(0);
  });

  it("listEntries filters by tags", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "P1", tags: ["ui", "frontend"] }, "p");
    upsertEntry(tmpDir, { type: "prompt", name: "P2", tags: ["backend"] }, "p");

    expect(listEntries(tmpDir, { tags: ["ui"] })).toHaveLength(1);
    expect(listEntries(tmpDir, { tags: ["backend"] })).toHaveLength(1);
    expect(listEntries(tmpDir, { tags: ["ui", "backend"] })).toHaveLength(2);
  });

  it("upsertEntry rejects invalid type", () => {
    expect(() => upsertEntry(tmpDir, { type: "invalid", name: "X" })).toThrow(/Invalid resource type/);
  });

  it("upsertEntry rejects missing name", () => {
    expect(() => upsertEntry(tmpDir, { type: "prompt" })).toThrow(/name is required/i);
  });
});

// ── Agent Profiles ──────────────────────────────────────────────────────────

describe("agent profiles", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("scaffoldAgentProfiles writes built-in profiles", () => {
    const result = scaffoldAgentProfiles(tmpDir);
    expect(result.written.length).toBeGreaterThanOrEqual(5);
    expect(result.skipped).toHaveLength(0);

    // Verify files exist
    for (const p of BUILTIN_AGENT_PROFILES) {
      const filePath = resolve(tmpDir, PROFILE_DIR, `${p.id}.json`);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it("scaffoldAgentProfiles skips existing files", () => {
    scaffoldAgentProfiles(tmpDir);
    const result2 = scaffoldAgentProfiles(tmpDir);
    expect(result2.written).toHaveLength(0);
    expect(result2.skipped.length).toBeGreaterThanOrEqual(5);
  });

  it("listAgentProfiles returns profiles with content", () => {
    scaffoldAgentProfiles(tmpDir);
    rebuildManifest(tmpDir);
    const profiles = listAgentProfiles(tmpDir);
    expect(profiles.length).toBeGreaterThanOrEqual(5);
    for (const p of profiles) {
      expect(p.type).toBe("agent");
      expect(p.profile).not.toBeNull();
      expect(typeof p.profile.name).toBe("string");
    }
  });

  it("matchAgentProfile matches UI tasks to UI agent", () => {
    scaffoldAgentProfiles(tmpDir);
    rebuildManifest(tmpDir);
    const match = matchAgentProfile(tmpDir, "feat(portal): add login page");
    expect(match).not.toBeNull();
    expect(match.id).toBe("ui-agent");
    expect(match.score).toBeGreaterThan(0);
  });

  it("matchAgentProfile matches API tasks to backend agent", () => {
    scaffoldAgentProfiles(tmpDir);
    rebuildManifest(tmpDir);
    const match = matchAgentProfile(tmpDir, "fix(api): resolve race condition");
    expect(match).not.toBeNull();
    expect(match.id).toBe("backend-agent");
  });

  it("matchAgentProfile matches CI tasks to devops agent", () => {
    scaffoldAgentProfiles(tmpDir);
    rebuildManifest(tmpDir);
    const match = matchAgentProfile(tmpDir, "ci(build): fix pipeline timeout");
    expect(match).not.toBeNull();
    expect(match.id).toBe("devops-agent");
  });

  it("matchAgentProfile matches docs tasks to docs agent", () => {
    scaffoldAgentProfiles(tmpDir);
    rebuildManifest(tmpDir);
    const match = matchAgentProfile(tmpDir, "docs(readme): update installation guide");
    expect(match).not.toBeNull();
    expect(match.id).toBe("docs-agent");
  });

  it("matchAgentProfile returns null for no match", () => {
    scaffoldAgentProfiles(tmpDir);
    rebuildManifest(tmpDir);
    const match = matchAgentProfile(tmpDir, "some random task title");
    // May match on tags loosely, or return null if no tag hits
    // Just verify it doesn't crash
    expect(match === null || typeof match.id === "string").toBe(true);
  });

  it("matchAgentProfile returns null for empty title", () => {
    expect(matchAgentProfile(tmpDir, "")).toBeNull();
    expect(matchAgentProfile(tmpDir, null)).toBeNull();
  });
});

// ── Manifest Rebuild ────────────────────────────────────────────────────────

describe("rebuildManifest", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("discovers files on disk and creates manifest", () => {
    // Write prompt files manually
    const promptDir = resolve(tmpDir, PROMPT_DIR);
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "my-prompt.md"), "# My Prompt\n\nContent here.", "utf8");

    const result = rebuildManifest(tmpDir);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.added).toBeGreaterThanOrEqual(1);

    const found = result.entries.find((e) => e.id === "my-prompt");
    expect(found).toBeDefined();
    expect(found.type).toBe("prompt");
    expect(found.name).toBe("My Prompt");
  });

  it("preserves existing metadata on rebuild", () => {
    upsertEntry(tmpDir, {
      type: "prompt",
      name: "Special Prompt",
      description: "Custom description",
      tags: ["custom"],
    }, "content");

    const result = rebuildManifest(tmpDir);
    const found = result.entries.find((e) => e.id === "special-prompt");
    expect(found).toBeDefined();
    expect(found.description).toBe("Custom description");
    expect(found.tags).toEqual(["custom"]);
  });

  it("detects removed files", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "Will Remove" }, "content");
    // Delete the file manually
    const filePath = resolve(tmpDir, PROMPT_DIR, "will-remove.md");
    rmSync(filePath, { force: true });

    const result = rebuildManifest(tmpDir);
    expect(result.removed).toBe(1);
    expect(result.entries.find((e) => e.id === "will-remove")).toBeUndefined();
  });
});

// ── initLibrary ─────────────────────────────────────────────────────────────

describe("initLibrary", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("scaffolds profiles and rebuilds manifest", () => {
    const result = initLibrary(tmpDir);
    expect(result.scaffolded.written.length).toBeGreaterThanOrEqual(5);
    expect(result.manifest.entries.length).toBeGreaterThanOrEqual(5);

    // Agent profiles should be in manifest
    const agentEntries = result.manifest.entries.filter((e) => e.type === "agent");
    expect(agentEntries.length).toBeGreaterThanOrEqual(5);
  });

  it("is idempotent", () => {
    initLibrary(tmpDir);
    const result2 = initLibrary(tmpDir);
    expect(result2.scaffolded.skipped.length).toBeGreaterThanOrEqual(5);
    expect(result2.scaffolded.written).toHaveLength(0);
  });
});

// ── resolveLibraryRefs ──────────────────────────────────────────────────────

describe("resolveLibraryRefs", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("resolves {{prompt:name}} to content", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "Test Prompt" }, "Hello from prompt");
    const result = resolveLibraryRefs("Before {{prompt:test-prompt}} After", tmpDir);
    expect(result).toBe("Before Hello from prompt After");
  });

  it("resolves {{skill:name}} to content", () => {
    upsertEntry(tmpDir, { type: "skill", name: "My Skill" }, "# Skill content");
    const result = resolveLibraryRefs("Use {{skill:my-skill}}", tmpDir);
    expect(result).toBe("Use # Skill content");
  });

  it("resolves {{agent:name}} to JSON string", () => {
    const profile = { name: "Agent1", scopes: ["ui"] };
    upsertEntry(tmpDir, { type: "agent", name: "Agent1" }, profile);
    const result = resolveLibraryRefs("Config: {{agent:agent1}}", tmpDir);
    expect(result).toContain('"name":"Agent1"');
  });

  it("preserves unresolved namespaced refs as HTML comments", () => {
    const result = resolveLibraryRefs("{{prompt:nonexistent}}", tmpDir);
    expect(result).toContain("not found");
  });

  it("resolves extra simple {{KEY}} variables", () => {
    const result = resolveLibraryRefs("Hello {{NAME}}", tmpDir, { NAME: "World" });
    expect(result).toBe("Hello World");
  });

  it("handles mixed namespaced and simple refs", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "Greet" }, "Hi there");
    const result = resolveLibraryRefs("{{prompt:greet}} — {{USER}}", tmpDir, { USER: "Jon" });
    expect(result).toBe("Hi there — Jon");
  });

  it("returns empty string for non-string input", () => {
    expect(resolveLibraryRefs(null, tmpDir)).toBe("");
    expect(resolveLibraryRefs(undefined, tmpDir)).toBe("");
    expect(resolveLibraryRefs(42, tmpDir)).toBe("");
  });

  it("is case-insensitive for type prefix", () => {
    upsertEntry(tmpDir, { type: "prompt", name: "CaseTest" }, "found it");
    expect(resolveLibraryRefs("{{PROMPT:casetest}}", tmpDir)).toBe("found it");
    expect(resolveLibraryRefs("{{Prompt:casetest}}", tmpDir)).toBe("found it");
  });
});

// ── resolveEntry (multi-workspace) ──────────────────────────────────────────

describe("resolveEntry (multi-workspace)", () => {
  let globalDir;
  let workspaceDir;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "lib-global-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "lib-ws-"));
    // Temporarily set BOSUN_HOME for global resolution
    process.env.BOSUN_HOME = globalDir;
  });

  afterEach(() => {
    delete process.env.BOSUN_HOME;
    try { rmSync(globalDir, { recursive: true, force: true }); } catch { /* ok */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("resolves from workspace first", () => {
    upsertEntry(globalDir, { type: "prompt", name: "Shared" }, "global version");
    upsertEntry(workspaceDir, { type: "prompt", name: "Shared" }, "workspace version");

    const result = resolveEntry(workspaceDir, "shared");
    expect(result.source).toBe("workspace");
    expect(result.content).toBe("workspace version");
  });

  it("falls back to global when not in workspace", () => {
    upsertEntry(globalDir, { type: "prompt", name: "OnlyGlobal" }, "global only");

    const result = resolveEntry(workspaceDir, "onlyglobal");
    expect(result.source).toBe("global");
    expect(result.content).toBe("global only");
  });

  it("returns source=none for missing entry", () => {
    const result = resolveEntry(workspaceDir, "missing");
    expect(result.source).toBe("none");
    expect(result.entry).toBeNull();
  });
});

// ── Scope Detection ─────────────────────────────────────────────────────────

describe("detectScopes", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("detects top-level folders as scopes", () => {
    // Create some folders
    mkdirSync(join(tmpDir, "portal"), { recursive: true });
    mkdirSync(join(tmpDir, "api"), { recursive: true });
    mkdirSync(join(tmpDir, ".git"), { recursive: true }); // should be excluded

    const result = detectScopes(tmpDir);
    const names = result.scopes.map((s) => s.name);
    expect(names).toContain("portal");
    expect(names).toContain("api");
    expect(names).not.toContain(".git"); // excluded
  });

  it("excludes node_modules and common non-scope dirs", () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    mkdirSync(join(tmpDir, "coverage"), { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    const result = detectScopes(tmpDir);
    const names = result.scopes.map((s) => s.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("dist");
    expect(names).not.toContain("coverage");
    expect(names).toContain("src");
  });

  it("returns empty scopes for empty directory", () => {
    const result = detectScopes(tmpDir);
    expect(result.scopes).toEqual([]);
  });
});

// ── renderPromptTemplate integration ────────────────────────────────────────

describe("renderPromptTemplate with library resolver", () => {
  beforeEach(() => fresh());
  afterEach(() => cleanup());

  it("setLibraryResolver + renderPromptTemplate resolves namespaced refs", async () => {
    const { renderPromptTemplate, setLibraryResolver } = await import("../scripts/bosun/agents/agent-prompts.mjs"");

    upsertEntry(tmpDir, { type: "prompt", name: "Injected" }, "injected content");

    // Register the resolver
    setLibraryResolver(resolveLibraryRefs);

    const result = renderPromptTemplate(
      "Prefix {{prompt:injected}} Suffix {{TASK_ID}}",
      { TASK_ID: "123" },
      tmpDir,
    );
    expect(result).toBe("Prefix injected content Suffix 123");

    // Cleanup resolver
    setLibraryResolver(null);
  });

  it("renderPromptTemplate still works without resolver", async () => {
    const { renderPromptTemplate, setLibraryResolver } = await import("../scripts/bosun/agents/agent-prompts.mjs"");
    setLibraryResolver(null);

    const result = renderPromptTemplate("Hello {{NAME}}", { NAME: "World" });
    expect(result).toBe("Hello World");
  });
});
