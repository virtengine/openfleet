import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  BUILTIN_SKILLS,
  scaffoldSkills,
  buildSkillsIndex,
  buildRelevantSkillsPromptBlock,
  findRelevantSkills,
  getSkillsDir,
} from "../agent/bosun-skills.mjs";
import { lintPromptText } from "../tools/prompt-lint.mjs";

let testHome;

async function makeTempHome() {
  const dir = await mkdtemp(resolve(tmpdir(), "bsa-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("builtin skills audit", () => {
  beforeEach(async () => {
    testHome = await makeTempHome();
  });

  afterEach(async () => {
    if (testHome && existsSync(testHome)) {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  it("keeps every builtin skill concise and metadata-complete", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);

    for (const skill of BUILTIN_SKILLS) {
      expect(skill.filename).toMatch(/\.md$/);
      expect(skill.title).toBeTruthy();
      expect(Array.isArray(skill.tags)).toBe(true);
      expect(skill.tags.length).toBeGreaterThan(0);
      expect(skill.scope).toBeTruthy();
      expect(skill.content).toBeTruthy();
      expect(skill.content.length).toBeLessThan(1000);
      expect(lintPromptText(skill.content, skill.filename)).toEqual([]);
    }
  });

  it("keeps the codebase audit skill compact but actionable", () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.filename === "skill-codebase-audit.md");

    expect(skill).toBeTruthy();
    expect(skill.title).toBe("Codebase Annotation Audit");
    expect(skill.tags).toEqual(expect.arrayContaining(["audit", "annotation", "documentation", "claude"]));
    expect(skill.content).toContain("CLAUDE:SUMMARY");
    expect(skill.content).toContain("CLAUDE:WARN");
    expect(skill.content).toContain("LEAN");
  });

  it("scaffolds builtin skills to disk", () => {
    scaffoldSkills(testHome);

    const skillsDir = getSkillsDir(testHome);
    for (const skill of BUILTIN_SKILLS) {
      const filePath = resolve(skillsDir, skill.filename);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe(skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`);
    }
  });

  it("includes builtin skills in the generated index", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    const indexPath = buildSkillsIndex(skillsDir);
    const index = JSON.parse(readFileSync(indexPath, "utf8"));

    expect(Array.isArray(index.skills)).toBe(true);
    expect(index.skills).toHaveLength(BUILTIN_SKILLS.length);

    const auditEntry = index.skills.find((entry) => entry.filename === "skill-codebase-audit.md");
    expect(auditEntry).toBeTruthy();
    expect(auditEntry.tags).toContain("audit");
  });

  it("matches relevant skills for audit tasks", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const matched = findRelevantSkills(testHome, "audit the codebase annotations");
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.some((entry) => entry.filename === "skill-codebase-audit.md")).toBe(true);
  });

  it("builds a compact relevant-skills prompt block", () => {
    scaffoldSkills(testHome);
    const skillsDir = getSkillsDir(testHome);
    buildSkillsIndex(skillsDir);

    const block = buildRelevantSkillsPromptBlock(testHome, "audit the codebase annotations", { maxSkills: 3 });
    expect(block).toContain("Relevant Skills");
    expect(block).toContain("skill-codebase-audit.md");
    expect(block).not.toContain("I will ");
  });
});
