import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function runNodeProbe(script, cwd = process.cwd()) {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function loadBuiltinSkillMeta() {
  const output = runNodeProbe(`
    const mod = await import('./agent/bosun-skills.mjs');
    const skill = mod.BUILTIN_SKILLS.find((entry) => entry.filename === 'skill-codebase-audit.md');
    console.log(JSON.stringify({
      filename: skill?.filename || '',
      title: skill?.title || '',
      scope: skill?.scope || '',
      important: skill?.important === true,
      tags: skill?.tags || [],
      content: skill?.content || '',
    }));
  `);
  return JSON.parse(output);
}

let testHome = "";

beforeEach(async () => {
  testHome = resolve(tmpdir(), `bsa-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(testHome, { recursive: true });
});

afterEach(async () => {
  if (testHome && existsSync(testHome)) {
    await rm(testHome, { recursive: true, force: true });
  }
});

describe("codebase annotation audit skill", () => {
  it("registers the builtin skill metadata", () => {
    const skill = loadBuiltinSkillMeta();
    expect(skill.filename).toBe("skill-codebase-audit.md");
    expect(skill.title).toBe("Codebase Annotation Audit");
    expect(skill.scope).toBe("global");
    expect(skill.important).toBe(true);
    expect(skill.tags).toEqual(expect.arrayContaining(["audit", "annotation", "documentation", "claude"]));
  });

  it("loads the checked-in markdown content", () => {
    const skill = loadBuiltinSkillMeta();
    const diskContent = readFileSync(resolve(process.cwd(), "agent", "skill-codebase-audit.md"), "utf8");
    expect(skill.content).toBe(diskContent);
  });

  it("contains the six-phase, documentation-only guidance", () => {
    const skill = loadBuiltinSkillMeta();
    expect(skill.content.length).toBeGreaterThan(500);
    expect(skill.content).toContain("6-Phase Audit Process");
    expect(skill.content).toContain("CLAUDE:SUMMARY");
    expect(skill.content).toContain("CLAUDE:WARN");
    expect(skill.content).toContain("documentation-only");
    expect(skill.content).toContain("Do not code, fix, refactor");
  });

  it("scaffolds the builtin skill and indexes it", () => {
    runNodeProbe(`
      const mod = await import('./agent/bosun-skills.mjs');
      const result = mod.scaffoldSkills(${JSON.stringify(testHome)});
      console.log(JSON.stringify(result));
    `);

    const skillPath = resolve(testHome, ".bosun", "skills", "skill-codebase-audit.md");
    const indexPath = resolve(testHome, ".bosun", "skills", "index.json");

    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("Codebase Annotation Audit");

    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const entry = index.skills.find((skill) => skill.filename === "skill-codebase-audit.md");
    expect(entry).toBeTruthy();
    expect(entry.important).toBe(true);
  });

  it("matches audit tasks and does not match unrelated coding tasks", () => {
    runNodeProbe(`
      const mod = await import('./agent/bosun-skills.mjs');
      mod.scaffoldSkills(${JSON.stringify(testHome)});
      const skillsDir = mod.getSkillsDir(${JSON.stringify(testHome)});
      mod.buildSkillsIndex(skillsDir);
    `);

    const matchedAudit = JSON.parse(runNodeProbe(`
      const mod = await import('./agent/bosun-skills.mjs');
      const matched = mod.findRelevantSkills(${JSON.stringify(testHome)}, 'audit the codebase annotations');
      console.log(JSON.stringify(matched.map((skill) => skill.filename)));
    `));
    expect(matchedAudit).toContain("skill-codebase-audit.md");

    const matchedFix = JSON.parse(runNodeProbe(`
      const mod = await import('./agent/bosun-skills.mjs');
      const matched = mod.findRelevantSkills(${JSON.stringify(testHome)}, 'fix button click handler in React component');
      console.log(JSON.stringify(matched.map((skill) => skill.filename)));
    `));
    expect(matchedFix).not.toContain("skill-codebase-audit.md");
  });

  it("indexes user-defined important skills and inlines them in the prompt block", () => {
    const skillsDir = resolve(testHome, ".bosun", "skills");
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

    const output = JSON.parse(runNodeProbe(`
      const mod = await import('./agent/bosun-skills.mjs');
      const skillsDir = mod.getSkillsDir(${JSON.stringify(testHome)});
      mod.buildSkillsIndex(skillsDir);
      const block = mod.buildRelevantSkillsPromptBlock(${JSON.stringify(testHome)}, 'critical deploy incident', 'investigate production deploy');
      const index = mod.loadSkillsIndex(${JSON.stringify(testHome)});
      console.log(JSON.stringify({ block, index }));
    `));

    const criticalEntry = output.index.skills.find((skill) => skill.filename === "critical-path.md");
    expect(criticalEntry).toBeTruthy();
    expect(criticalEntry.important).toBe(true);
    expect(output.block).toContain("Critical Path");
    expect(output.block).toContain("Handle deploy incidents carefully.");
    expect(output.block).toContain("[important]");
  });
});
