/**
 * @module tests/bosun-skills-audit.test.mjs
 * @description Unit tests for the codebase-annotation-audit builtin skill.
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
  findRelevantSkills,
  getSkillsDir,
} from "../bosun-skills.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

let testHome;

async function makeTempHome() {
  const dir = resolve(tmpdir(), `bsa-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(skill).toBeTruthy();
  });

  it("has correct metadata", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(skill.title).toBe("Codebase Annotation Audit");
    expect(skill.scope).toBe("global");
    expect(skill.tags).toContain("audit");
    expect(skill.tags).toContain("annotation");
    expect(skill.tags).toContain("documentation");
    expect(skill.tags).toContain("summary");
    expect(skill.tags).toContain("claude");
  });

  it("has non-empty content with expected sections", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(skill.content).toBeTruthy();
    expect(skill.content.length).toBeGreaterThan(500);

    // Key sections
    expect(skill.content).toContain("Annotation Format");
    expect(skill.content).toContain("CLAUDE:SUMMARY");
    expect(skill.content).toContain("CLAUDE:WARN");
    expect(skill.content).toContain("6-Phase Audit");
    expect(skill.content).toContain("Phase 1");
    expect(skill.content).toContain("Inventory");
  });

  it("contains LEAN philosophy section", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(skill.content).toContain("LEAN");
    expect(skill.content).toContain("documentation-only");
  });

  it("includes success metrics", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(skill.content).toContain("4×");
    expect(skill.content).toContain("20%");
  });

  // ── Scaffolding ─────────────────────────────────────────────────────────

  it("is scaffolded to disk by scaffoldSkills()", () => {
    scaffoldSkills(testHome);

    const skillsDir = getSkillsDir(testHome);
    const filePath = resolve(skillsDir, "codebase-annotation-audit.md");
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

    const auditEntry = index.skills.find((s) => s.filename === "codebase-annotation-audit.md");
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

    const auditSkill = matched.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(auditSkill).toBeTruthy();
    expect(auditSkill.content).toContain("CLAUDE:SUMMARY");
  });

  it("is matched by findRelevantSkills for documentation tasks", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const matched = findRelevantSkills(testHome, "documentation summary for the codebase");
    const auditSkill = matched.find((s) => s.filename === "codebase-annotation-audit.md");
    expect(auditSkill).toBeTruthy();
  });

  it("is NOT matched by unrelated task titles", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const matched = findRelevantSkills(testHome, "fix button click handler in React component");
    const auditSkill = matched.find((s) => s.filename === "codebase-annotation-audit.md");
    // Should not match — audit tags are not in this title
    expect(auditSkill).toBeFalsy();
  });
});
