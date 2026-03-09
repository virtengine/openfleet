import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIndexMap,
  generateManifests,
  generateSummaries,
  generateWarnings,
  migrateAnnotations,
  runAuditCli,
  runConformity,
  scanRepository,
  trimAuditArtifacts,
} from "../lib/codebase-audit.mjs";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

function createRepo() {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-audit-"));
  tempRoots.push(root);
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "pkg"), { recursive: true });
  mkdirSync(resolve(root, "cmd"), { recursive: true });
  writeFileSync(
    resolve(root, "src", "app.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      '',
      'let cache;',
      'export async function loadConfig() {',
      '  if (!cache) cache = await import("./lazy.mjs");',
      '  writeFileSync("tmp.txt", "ok");',
      '  return cache;',
      '}',
      '',
      'export function noop() {',
      '  return true;',
      '}',
      '',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(root, "pkg", "worker.py"),
    [
      '# CLAUDE:SUMMARY Owns worker logic for pkg.',
      '',
      'def run():',
      '    return 1',
      '',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(root, "cmd", "server.go"),
    [
      'package main',
      '',
      'func Start() error {',
      '  return nil',
      '}',
      '',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(root, "src", "lib.rs"),
    [
      'pub fn bootstrap() {',
      '    println!("hello");',
      '}',
      '',
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("codebase audit engine", () => {
  it("scans supported languages and reports missing annotations", () => {
    const root = createRepo();
    const result = scanRepository(root, { dryRun: true });

    expect(result.totals.files).toBe(4);
    expect(result.totals.missingSummary).toBe(3);
    expect(result.languages.javascript).toBe(1);
    expect(result.languages.python).toBe(1);
    expect(result.languages.go).toBe(1);
    expect(result.languages.rust).toBe(1);
    expect(result.warningKinds["lazy-init"]).toBeGreaterThan(0);
    expect(result.warningKinds["side-effects"]).toBeGreaterThan(0);
  });

  it("generates summaries and warnings for source files", () => {
    const root = createRepo();

    const summaryResult = generateSummaries(root);
    expect(summaryResult.added).toBe(3);

    const warnResult = generateWarnings(root);
    expect(warnResult.added).toBeGreaterThan(0);

    const appContent = readFileSync(resolve(root, "src", "app.mjs"), "utf8");
    expect(appContent).toContain("CLAUDE:SUMMARY");
    expect(appContent).toContain("CLAUDE:WARN");
    expect(appContent).toMatch(/CLAUDE:WARN[\s\S]*export async function loadConfig/);

    const goContent = readFileSync(resolve(root, "cmd", "server.go"), "utf8");
    expect(goContent).toContain("CLAUDE:SUMMARY");
  });

  it("builds manifests and index files", () => {
    const root = createRepo();
    generateSummaries(root);
    generateWarnings(root);

    const manifestResult = generateManifests(root);
    const indexResult = buildIndexMap(root);
    const trimResult = trimAuditArtifacts(root, { dryRun: true });

    expect(manifestResult.directories).toBeGreaterThan(0);
    expect(indexResult.entries).toBe(4);
    expect(trimResult.conformityScore).toBeGreaterThanOrEqual(0);
    expect(existsSync(resolve(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(resolve(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(resolve(root, "INDEX.map"))).toBe(true);
  });

  it("migrates BOSUN markers and fails conformity on leaks", async () => {
    const root = createRepo();
    writeFileSync(
      resolve(root, "src", "legacy.py"),
      [
        '# BOSUN:SUMMARY Legacy summary.',
        '',
        'def legacy():',
        '    return True',
        '',
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      resolve(root, "src", "secret.mjs"),
      'const token = "sk-1234567890ABCDEFGHIJKLMNOP";\n',
      "utf8",
    );

    const migrateResult = migrateAnnotations(root);
    expect(migrateResult.migrated).toBeGreaterThan(0);
    expect(readFileSync(resolve(root, "src", "legacy.py"), "utf8")).toContain("CLAUDE:SUMMARY");

    const conformity = runConformity(root, { dryRun: true });
    expect(conformity.ok).toBe(false);
    expect(conformity.credentialFindings.length).toBeGreaterThan(0);

    const stdout = [];
    const cliRun = await runAuditCli(["conformity", "--root", root], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line),
    });
    expect(cliRun.exitCode).toBe(1);
    expect(stdout.join("\n")).toContain("Conformity failed");
  });

  it("treats --ci as a conformity alias with exit gating", async () => {
    const root = createRepo();

    const failingRun = await runAuditCli(["--ci", "--root", root], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(failingRun.exitCode).toBe(1);
    expect(failingRun.result.command).toBe("conformity");

    generateSummaries(root);
    generateWarnings(root);

    const passingRun = await runAuditCli(["--ci", "--root", root], {
      stdout: () => {},
      stderr: () => {},
    });
    expect(passingRun.exitCode).toBe(0);
    expect(passingRun.result.ok).toBe(true);
  });
});
