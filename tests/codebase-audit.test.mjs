import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  buildAuditIndex,
  generateManifests,
  generateSummaries,
  generateWarnings,
  runAuditConformity,
  runAuditMigration,
  scanRepository,
  trimAuditManifests,
} from "../tools/codebase-audit.mjs";

let repoDir;

function writeRepoFile(relativePath, content) {
  const filePath = resolve(repoDir, relativePath);
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("codebase audit CLI helpers", () => {
  beforeEach(async () => {
    repoDir = await mkdtemp(resolve(tmpdir(), "bosun-audit-"));
    writeRepoFile(
      "src/app.mjs",
      [
        "import { loadClient } from './lazy.mjs';",
        "",
        "export function start() {",
        "  void loadClient();",
        "  return true;",
        "}",
      ].join("\n"),
    );
    writeRepoFile(
      "src/lazy.mjs",
      [
        "let client = null;",
        "",
        "export async function loadClient() {",
        "  if (!client) {",
        "    const { createClient } = await import('./dep.mjs');",
        "    client = createClient();",
        "  }",
        "  return client;",
        "}",
      ].join("\n"),
    );
    writeRepoFile(
      "src/dep.mjs",
      [
        "import { start } from './app.mjs';",
        "",
        "export function createClient() {",
        "  start();",
        "  return { ok: true };",
        "}",
      ].join("\n"),
    );
    writeRepoFile(
      "src/helper.py",
      [
        "def build_message(name):",
        "    return f'hello {name}'",
      ].join("\n"),
    );
    writeRepoFile(
      "src/legacy.py",
      [
        "# BOSUN:SUMMARY Legacy helper summary.",
        "def legacy():",
        "    return True",
      ].join("\n"),
    );
    writeRepoFile(
      "src/stale.mjs",
      [
        "// CLAUDE:SUMMARY Handles stale responsibilities and exposes MissingThing.",
        "export function currentThing() {",
        "  return 'ok';",
        "}",
      ].join("\n"),
    );
    writeRepoFile(
      "src/leak.mjs",
      [
        "// CLAUDE:SUMMARY Handles leak detection coverage.",
        "export const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("scans supported files and writes inventory output", () => {
    const { inventory, inventoryPath } = scanRepository(repoDir);
    expect(inventory.fileCount).toBe(7);
    expect(inventory.missingSummary).toBeGreaterThanOrEqual(4);
    expect(existsSync(inventoryPath)).toBe(true);
    expect(readFileSync(inventoryPath, "utf8")).toContain('"missingSummary"');
  });

  it("generates CLAUDE summary annotations for JS and Python files", () => {
    const { changed } = generateSummaries(repoDir, {
      files: ["src/app.mjs", "src/helper.py"],
    });
    expect(changed).toBe(2);
    expect(readFileSync(resolve(repoDir, "src/app.mjs"), "utf8")).toContain("// CLAUDE:SUMMARY");
    expect(readFileSync(resolve(repoDir, "src/helper.py"), "utf8")).toContain("# CLAUDE:SUMMARY");
  });

  it("adds warning annotations for lazy init and dynamic import hazards", () => {
    const { changed } = generateWarnings(repoDir, { files: ["src/lazy.mjs"] });
    const content = readFileSync(resolve(repoDir, "src/lazy.mjs"), "utf8");
    expect(changed).toBeGreaterThan(0);
    expect(content).toContain("CLAUDE:WARN This file uses lazy initialization");
    expect(content).toContain("CLAUDE:WARN Function loadClient does dynamic imports");
  });

  it("detects import cycles and annotates the affected file", () => {
    const { inventory } = scanRepository(repoDir, { files: ["src/app.mjs", "src/dep.mjs", "src/lazy.mjs"] });
    const appEntry = inventory.fileInfos.find((entry) => entry.relativePath === "src/app.mjs");
    expect(appEntry.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("import cycle") }),
      ]),
    );

    const { changed } = generateWarnings(repoDir, { files: ["src/app.mjs", "src/dep.mjs", "src/lazy.mjs"] });
    const appContent = readFileSync(resolve(repoDir, "src/app.mjs"), "utf8");
    expect(changed).toBeGreaterThan(0);
    expect(appContent).toContain("CLAUDE:WARN This file participates in an import cycle");
  });

  it("builds manifests and an index map from generated summaries", () => {
    generateSummaries(repoDir, { files: ["src/app.mjs", "src/lazy.mjs", "src/dep.mjs", "src/helper.py"] });
    const { writtenFiles } = generateManifests(repoDir);
    const { indexPath } = buildAuditIndex(repoDir);
    trimAuditManifests(repoDir);

    expect(writtenFiles.some((filePath) => filePath.endsWith("CLAUDE.md"))).toBe(true);
    expect(existsSync(resolve(repoDir, "src", "CLAUDE.md"))).toBe(true);
    expect(existsSync(resolve(repoDir, "src", "AGENTS.md"))).toBe(true);
    expect(readFileSync(resolve(repoDir, "src", "AGENTS.md"), "utf8")).toContain("BOSUN:AUDIT:START");
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, "utf8")).toContain("src/app.mjs | core |");
  });

  it("migrates legacy markers and reports stale annotations plus leaks", () => {
    const { migrated } = runAuditMigration(repoDir, { files: ["src/legacy.py"] });
    const migratedContent = readFileSync(resolve(repoDir, "src/legacy.py"), "utf8");
    const { report } = runAuditConformity(repoDir, {
      files: ["src/stale.mjs", "src/leak.mjs", "src/legacy.py"],
    });

    expect(migrated).toBe(1);
    expect(migratedContent).toContain("CLAUDE:SUMMARY");
    expect(report.ok).toBe(false);
    expect(report.staleAnnotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/stale.mjs", symbol: "MissingThing" }),
      ]),
    );
    expect(report.credentialLeaks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/leak.mjs", kind: "openai-key" }),
      ]),
    );
  });
});
