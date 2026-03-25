/**
 * @module tests/bosun-skills-audit.test.mjs
 * @description Unit tests for builtin Bosun skill scaffolding and budgets.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  BUILTIN_SKILLS,
  scaffoldSkills,
  buildSkillsIndex,
  buildRelevantSkillsPromptBlock,
  findRelevantSkills,
  getSkillsDir,
  loadSkillsForTask,
} from "../agent/bosun-skills.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

let testHome;

async function makeTempHome() {
  const dir = resolve(tmpdir(), `bsa-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_SKILL_CHARS = 1000;

// Reference skills that exceed the standard conciseness budget.
const LARGE_REFERENCE_SKILLS = new Set(["skill-codebase-audit.md"]);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("codebase-annotation-audit skill", () => {
  beforeEach(async () => {
    testHome = await makeTempHome();
  });

  afterEach(async () => {
    if (testHome && existsSync(testHome)) {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  // ── Skill Registration ──────────────────────────────────────────────────

  it("is present in BUILTIN_SKILLS", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "skill-codebase-audit.md");
    expect(skill).toBeTruthy();
  });

  it("has correct metadata", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "skill-codebase-audit.md");
    expect(skill.title).toBe("Codebase Annotation Audit");
    expect(skill.scope).toBe("global");
    expect(skill.tags).toContain("audit");
    expect(skill.tags).toContain("annotation");
    expect(skill.tags).toContain("documentation");
    expect(skill.tags).toContain("summary");
    expect(skill.tags).toContain("claude");
  });

  it("keeps every built-in skill concise and bullet-oriented", () => {
    const oversized = BUILTIN_SKILLS
      .filter((skill) => !LARGE_REFERENCE_SKILLS.has(skill.filename))
      .filter((skill) => skill.content.length > MAX_SKILL_CHARS)
      .map((skill) => `${skill.filename}:${skill.content.length}`);

    expect(oversized).toEqual([]);

    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain(`# Skill: ${skill.title}`);
      expect(skill.content).toContain("- ");
    }
  });

  it("has concise content with expected guidance", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "skill-codebase-audit.md");
    expect(skill.content).toBeTruthy();
    // This is a larger reference skill; verify it stays within a generous budget.
    expect(skill.content.length).toBeLessThanOrEqual(5000);
    expect(skill.content).toContain("CLAUDE:SUMMARY");
    expect(skill.content).toContain("CLAUDE:WARN");
    expect(skill.content).toContain("Phase 1");
    expect(skill.content).toContain("documentation-only");
  });

  it("loads content from the checked-in markdown file", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "skill-codebase-audit.md");
    const diskContent = readFileSync(resolve("agent", "skills", "skill-codebase-audit.md"), "utf8");
    expect(skill.content).toBe(diskContent);
  });

  // ── Scaffolding ─────────────────────────────────────────────────────────

  it("is scaffolded to disk by scaffoldSkills()", () => {
    scaffoldSkills(testHome);

    const skillsDir = getSkillsDir(testHome);
    const filePath = resolve(skillsDir, "skill-codebase-audit.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("Codebase Annotation Audit");
    expect(content).toContain("CLAUDE:SUMMARY");
  });

  // ── Index & Discovery ───────────────────────────────────────────────────

  it("appears in skill index after scaffolding", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    const indexPath = buildSkillsIndex(skillsDir);

    expect(indexPath).toBeTruthy();
    expect(existsSync(indexPath)).toBe(true);

    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    expect(Array.isArray(index.skills)).toBe(true);

    const auditEntry = index.skills.find((s) => s.filename === "skill-codebase-audit.md");
    expect(auditEntry).toBeTruthy();
    expect(auditEntry.title).toContain("Annotation Audit");
    expect(auditEntry.tags).toContain("audit");
  });

  it("is matched by findRelevantSkills for audit tasks", () => {
    scaffoldSkills(testHome);

    // buildSkillsIndex writes index.json to disk, which findRelevantSkills reads
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const matched = findRelevantSkills(testHome, "audit the codebase annotations");
    expect(matched.length).toBeGreaterThan(0);

    const auditSkill = matched.find((s) => s.filename === "skill-codebase-audit.md");
    expect(auditSkill).toBeTruthy();
    expect(auditSkill.content).toContain("CLAUDE:SUMMARY");
  });

  it("is matched by findRelevantSkills for documentation tasks", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const matched = findRelevantSkills(testHome, "documentation summary for the codebase");
    const auditSkill = matched.find((s) => s.filename === "skill-codebase-audit.md");
    expect(auditSkill).toBeTruthy();
  });

  it("is NOT matched by unrelated task titles", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const matched = findRelevantSkills(testHome, "fix button click handler in React component");
    const auditSkill = matched.find((s) => s.filename === "skill-codebase-audit.md");
    // Should not match — audit tags are not in this title
    expect(auditSkill).toBeFalsy();
  });

  it("indexes user-defined important skills from metadata comments", () => {
    const skillsDir = getSkillsDir(testHome);
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      resolve(skillsDir, "critical-path.md"),
      [
        "<!-- tags: critical deploy incident -->",
        "<!-- important: true -->",
        "# Skill: Critical Path",
        "",
        "Handle deploy incidents carefully.",
      ].join("\n"),
      "utf8",
    );
    const indexPath = buildSkillsIndex(skillsDir);
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const entry = index.skills.find((skill) => skill.filename === "critical-path.md");
    expect(entry).toBeTruthy();
    expect(entry.important).toBe(true);
    expect(entry.tags).toContain("incident");
  });

  it("inlines matched important skills in the prompt block", () => {
    const skillsDir = getSkillsDir(testHome);
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      resolve(skillsDir, "critical-path.md"),
      [
        "<!-- tags: critical deploy incident -->",
        "<!-- important: true -->",
        "# Skill: Critical Path",
        "",
        "Handle deploy incidents carefully.",
      ].join("\n"),
      "utf8",
    );
    buildSkillsIndex(skillsDir);

    const block = buildRelevantSkillsPromptBlock(
      testHome,
      "critical deploy incident",
      "investigate production deploy",
    );
    expect(block).toContain("Critical Path");
    expect(block).toContain("Handle deploy incidents carefully.");
    expect(block).toContain("[important]");
  });

  it("loadSkillsForTask returns empty string when no tags match", () => {
    scaffoldSkills(testHome);
    buildSkillsIndex(getSkillsDir(testHome));

    const block = loadSkillsForTask(testHome, {
      title: "refactor metrics aggregator",
      description: "clean up scheduler internals",
      labels: ["maintenance", "backend"],
    });

    expect(block).toBe("");
  });

  it("loadSkillsForTask ranks by tag matches and respects the char budget", () => {
    const skillsDir = getSkillsDir(testHome);
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      resolve(skillsDir, "two-hit.md"),
      [
        "<!-- tags: deploy incident -->",
        "# Skill: Two Hit",
        "",
        "Handle deploy incidents with a rollback plan and verification checklist.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      resolve(skillsDir, "one-hit.md"),
      [
        "<!-- tags: deploy -->",
        "# Skill: One Hit",
        "",
        "Handle deployments carefully.",
      ].join("\n"),
      "utf8",
    );
    buildSkillsIndex(skillsDir);

    const block = loadSkillsForTask(
      testHome,
      {
        title: "deploy incident hotfix",
        description: "production deploy failed during incident response",
        labels: ["incident", "ops"],
      },
      { maxChars: 220 },
    );

    expect(block).toContain("Two Hit");
    expect(block).not.toContain("One Hit");
    expect(block.length).toBeLessThanOrEqual(220);
  });

  it("loadSkillsForTask respects BOSUN_SKILLS_MAX_CHARS when opts.maxChars is omitted", () => {
    const skillsDir = getSkillsDir(testHome);
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      resolve(skillsDir, "incident-response.md"),
      [
        "<!-- tags: incident deploy hotfix -->",
        "# Skill: Incident Response",
        "",
        "Use rollback criteria, validation steps, and stakeholder updates during deploy incidents.",
      ].join("\n"),
      "utf8",
    );
    buildSkillsIndex(skillsDir);

    const previousBudget = process.env.BOSUN_SKILLS_MAX_CHARS;
    process.env.BOSUN_SKILLS_MAX_CHARS = "160";

    try {
      const block = loadSkillsForTask(testHome, {
        title: "deploy incident hotfix",
        description: "production deploy incident with customer impact",
        labels: ["incident", "ops"],
      });

      expect(block).toBe("");
    } finally {
      if (previousBudget === undefined) {
        delete process.env.BOSUN_SKILLS_MAX_CHARS;
      } else {
        process.env.BOSUN_SKILLS_MAX_CHARS = previousBudget;
      }
    }
  });
});
