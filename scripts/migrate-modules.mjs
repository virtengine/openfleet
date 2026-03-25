#!/usr/bin/env node
/**
 * migrate-modules.mjs — Reorganize bosun root modules into sub-folders.
 *
 * This script:
 *  1. Defines the complete old-path → new-path mapping
 *  2. Creates required sub-directories
 *  3. Moves files via `git mv`
 *  4. Rewrites all import/require/dynamic-import paths in every .mjs file
 *  5. Rewrites resolve(process.cwd(), ...) & resolve(dir, "..", ...) patterns in tests
 *  6. Updates package.json (exports, bin, files, scripts)
 *
 * IMPORTANT: Run this script EXACTLY ONCE. It is NOT idempotent.
 *
 * Usage: node scripts/migrate-modules.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, relative, dirname, basename } from "node:path";
import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry-run");
const ROOT = resolve(import.meta.dirname, "..");

// Guard: if files are already moved, refuse to run again
if (existsSync(resolve(ROOT, "agent", "agent-hooks.mjs")) && !existsSync(resolve(ROOT, "agent-hooks.mjs"))) {
  console.error("ERROR: Migration already performed (agent/agent-hooks.mjs exists). Aborting.");
  process.exit(1);
}

// ─── file → subfolder mapping ────────────────────────────────────────────────
// Only files that MOVE are listed. Files not listed stay at root.
const MOVES = {
  // ── agent/ ── Agent orchestration, hooks, skills, analysis ──────────────
  "agent-custom-tools.mjs":       "agent/",
  "agent-endpoint.mjs":           "agent/",
  "agent-event-bus.mjs":          "agent/",
  "agent-hook-bridge.mjs":        "agent/",
  "agent-hooks.mjs":              "agent/",
  "agent-pool.mjs":               "agent/",
  "agent-prompts.mjs":            "agent/",
  "agent-sdk.mjs":                "agent/",
  "agent-supervisor.mjs":         "agent/",
  "agent-tool-config.mjs":        "agent/",
  "agent-work-analyzer.mjs":      "agent/",
  "agent-work-report.mjs":        "agent/",
  "analyze-agent-work-helpers.mjs": "agent/",
  "analyze-agent-work.mjs":       "agent/",
  "primary-agent.mjs":            "agent/",
  "review-agent.mjs":             "agent/",
  "fleet-coordinator.mjs":        "agent/",
  "hook-profiles.mjs":            "agent/",
  "bosun-skills.mjs":             "agent/",
  "autofix.mjs":                  "agent/",

  // ── voice/ ── Voice/speech features ─────────────────────────────────────
  "voice-action-dispatcher.mjs":  "voice/",
  "voice-agents-sdk.mjs":         "voice/",
  "voice-auth-manager.mjs":       "voice/",
  "voice-relay.mjs":              "voice/",
  "voice-tools.mjs":              "voice/",
  "vision-session-state.mjs":     "voice/",

  // ── task/ ── Task management ────────────────────────────────────────────
  "task-archiver.mjs":            "task/",
  "task-assessment.mjs":          "task/",
  "task-attachments.mjs":         "task/",
  "task-claims.mjs":              "task/",
  "task-cli.mjs":                 "task/",
  "task-complexity.mjs":          "task/",
  "task-context.mjs":             "task/",
  "task-debt-ledger.mjs":         "task/",
  "task-executor.mjs":            "task/",
  "task-store.mjs":               "task/",

  // ── git/ ── Git operations ──────────────────────────────────────────────
  "git-commit-helpers.mjs":       "git/",
  "git-editor-fix.mjs":           "git/",
  "git-safety.mjs":               "git/",
  "conflict-resolver.mjs":        "git/",
  "sdk-conflict-resolver.mjs":    "git/",
  "diff-stats.mjs":               "git/",

  // ── shell/ ── AI shell integrations ─────────────────────────────────────
  "claude-shell.mjs":             "shell/",
  "codex-shell.mjs":              "shell/",
  "copilot-shell.mjs":            "shell/",
  "gemini-shell.mjs":             "shell/",
  "opencode-shell.mjs":           "shell/",
  "opencode-providers.mjs":       "shell/",
  "codex-config.mjs":             "shell/",
  "codex-model-profiles.mjs":     "shell/",
  "pwsh-runtime.mjs":             "shell/",

  // ── workflow/ ── Workflow engine ─────────────────────────────────────────
  "workflow-engine.mjs":          "workflow/",
  "workflow-migration.mjs":       "workflow/",
  "workflow-nodes.mjs":           "workflow/",
  "workflow-templates.mjs":       "workflow/",
  "mcp-workflow-adapter.mjs":     "workflow/",
  "mcp-registry.mjs":             "workflow/",
  "manual-flows.mjs":             "workflow/",
  "meeting-workflow-service.mjs": "workflow/",

  // ── config/ ── Configuration ────────────────────────────────────────────
  "config.mjs":                   "config/",
  "config-doctor.mjs":            "config/",
  "context-shredding-config.mjs": "config/",
  "repo-config.mjs":              "config/",
  "repo-root.mjs":                "config/",

  // ── telegram/ ── Telegram & messaging ───────────────────────────────────
  "telegram-bot.mjs":             "telegram/",
  "telegram-poll-owner.mjs":      "telegram/",
  "telegram-sentinel.mjs":        "telegram/",
  "get-telegram-chat-id.mjs":     "telegram/",
  "whatsapp-channel.mjs":         "telegram/",

  // ── github/ ── GitHub integration ───────────────────────────────────────
  "github-app-auth.mjs":          "github/",
  "github-auth-manager.mjs":      "github/",
  "github-oauth-portal.mjs":      "github/",
  "marketplace-webhook.mjs":      "github/",
  "issue-trust-guard.mjs":        "github/",

  // ── workspace/ ── Workspace management ──────────────────────────────────
  "workspace-manager.mjs":        "workspace/",
  "workspace-monitor.mjs":        "workspace/",
  "workspace-registry.mjs":       "workspace/",
  "worktree-manager.mjs":         "workspace/",
  "shared-workspace-cli.mjs":     "workspace/",
  "shared-workspace-registry.mjs":"workspace/",
  "shared-state-manager.mjs":     "workspace/",
  "shared-knowledge.mjs":         "workspace/",
  "context-cache.mjs":            "workspace/",
  "context-indexer.mjs":          "workspace/",

  // ── kanban/ ── Kanban / VE board ────────────────────────────────────────
  "kanban-adapter.mjs":           "kanban/",


  // ── infra/ ── Runtime / infrastructure ──────────────────────────────────
  "monitor.mjs":                  "infra/",
  "restart-controller.mjs":       "infra/",
  "startup-service.mjs":          "infra/",
  "update-check.mjs":             "infra/",
  "maintenance.mjs":              "infra/",
  "preflight.mjs":                "infra/",
  "presence.mjs":                 "infra/",
  "session-tracker.mjs":          "infra/",
  "stream-resilience.mjs":        "infra/",
  "anomaly-detector.mjs":         "infra/",
  "error-detector.mjs":           "infra/",
  "container-runner.mjs":         "infra/",
  "daemon-restart-policy.mjs":    "infra/",
  "fetch-runtime.mjs":            "infra/",
  "sync-engine.mjs":              "infra/",
  "desktop-api-key.mjs":          "infra/",
  "desktop-shortcut.mjs":         "infra/",
  "library-manager.mjs":          "infra/",

  // ── server/ ── UI / web server ──────────────────────────────────────────
  "ui-server.mjs":                "server/",
  "setup-web-server.mjs":         "server/",
  "playwright-ui-inspect.mjs":    "server/",
  "playwright-ui-server.mjs":     "server/",
};

// ── companion non-.mjs files that travel with their .mjs counterparts ─────
const COMPANION_MOVES = {
  "fix-stuck-rebase.ps1":"git/",
  "rotate-agent-logs.sh":"agent/",
};

// ─── build the resolution map ─────────────────────────────────────────────
// old relative path (from ROOT) → new relative path (from ROOT)
const pathMap = new Map(); // "./old.mjs" → "./folder/old.mjs"

for (const [file, folder] of Object.entries(MOVES)) {
  pathMap.set(`./${file}`, `./${folder}${file}`);
}

// Also handle lib/logger.mjs which already lives in a subfolder
// (we leave it where it is — no move needed)

// ─── helper: compute new relative import path ─────────────────────────────
function rewriteImport(importerOldPath, importerNewPath, specifier) {
  // Only rewrite local relative imports
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;

  // Resolve the target's old absolute path
  const importerOldDir = dirname(resolve(ROOT, importerOldPath));
  const targetOldAbs = resolve(importerOldDir, specifier);
  const targetOldRel = "./" + relative(ROOT, targetOldAbs).replace(/\\/g, "/");

  // Look up if this target was moved
  // Try exact match first, then with .mjs extension
  let targetNewRel = pathMap.get(targetOldRel);
  if (!targetNewRel && !targetOldRel.endsWith(".mjs")) {
    targetNewRel = pathMap.get(targetOldRel + ".mjs");
  }
  // Try without extension
  if (!targetNewRel) {
    const withExt = targetOldRel.endsWith(".mjs") ? targetOldRel : targetOldRel + ".mjs";
    targetNewRel = pathMap.get(withExt);
  }

  // If the target didn't move, it's still at its old location
  const finalTargetRel = targetNewRel || targetOldRel;

  // Compute the new relative path from the importer's new location
  const importerNewDir = dirname(resolve(ROOT, importerNewPath));
  const targetNewAbs = resolve(ROOT, finalTargetRel);
  let newSpec = relative(importerNewDir, targetNewAbs).replace(/\\/g, "/");

  // Ensure it starts with ./ or ../
  if (!newSpec.startsWith(".")) newSpec = "./" + newSpec;

  return newSpec;
}

// ─── step 1: create directories ───────────────────────────────────────────
const dirs = new Set(Object.values(MOVES));
for (const d of Object.values(COMPANION_MOVES)) dirs.add(d);

for (const d of dirs) {
  const full = resolve(ROOT, d);
  if (!existsSync(full)) {
    console.log(`  mkdir ${d}`);
    if (!DRY) mkdirSync(full, { recursive: true });
  }
}

// ─── step 2: git mv files ────────────────────────────────────────────────
console.log("\n=== Moving files ===");
const allMoves = { ...MOVES, ...COMPANION_MOVES };
for (const [file, folder] of Object.entries(allMoves)) {
  const src = resolve(ROOT, file);
  if (!existsSync(src)) {
    console.log(`  SKIP (not found): ${file}`);
    continue;
  }
  const dst = resolve(ROOT, folder, file);
  console.log(`  ${file} → ${folder}${file}`);
  if (!DRY) {
    execSync(`git mv "${file}" "${folder}${file}"`, { cwd: ROOT, stdio: "pipe" });
  }
}

// ─── step 3: collect ALL .mjs files that need import rewriting ────────────
console.log("\n=== Rewriting imports ===");

function collectMjsFiles(dir, rel = "") {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".bosun", ".cache", "vendor", "site",
           "workflow-templates", "desktop", ".github", ".githooks",
           ".agents", ".claude", ".codex", ".vscode", "bench",
           "playwright-screenshots", "test-results", "logs", "_docs",
           "docs"].includes(entry.name)) continue;
      results.push(...collectMjsFiles(resolve(dir, entry.name), entryRel));
    } else if (entry.name.endsWith(".mjs")) {
      results.push(entryRel);
    }
  }
  return results;
}

const allFiles = collectMjsFiles(ROOT);
console.log(`  Found ${allFiles.length} .mjs files to scan`);

// Static import/export: from "./path"
const STATIC_RE = /(from\s+["'])(\.[^"']+)(["'])/g;
// Dynamic import: import("./path")
const DYNAMIC_RE = /(import\s*\(\s*["'])(\.[^"']+)(["']\s*\))/g;
// resolve(process.cwd(), "filename.mjs")  — used in tests
const RESOLVE_CWD_RE = /(resolve\s*\(\s*process\.cwd\(\)\s*,\s*["'])([^"']+)(["'])/g;
// resolve(dir, "..", "filename.mjs") — used in some test source-scanning
const RESOLVE_DIR_PARENT_RE = /(resolve\s*\(\s*dir\s*,\s*["']\.\.["']\s*,\s*["'])([^"']+)(["'])/g;

let filesChanged = 0;
let importsRewritten = 0;

for (const fileRel of allFiles) {
  // Determine old and new paths for this file
  const fileName = basename(fileRel);
  const fileDir = dirname(fileRel);

  // What was this file's old relative path (from ROOT)?
  let oldRel, newRel;

  if (fileDir === "." || fileDir === "") {
    // Root-level files that may have been moved
    const newFolder = MOVES[fileName];
    oldRel = `./${fileName}`;
    newRel = newFolder ? `./${newFolder}${fileName}` : `./${fileName}`;
  } else if (fileDir === "tests") {
    oldRel = `./${fileRel}`;
    newRel = `./${fileRel}`; // tests don't move
  } else {
    // Files already in subfolders (agent/, voice/, etc. — just moved there)
    // Check if this was a root file that got moved
    const possibleOldName = fileName;
    if (MOVES[possibleOldName] && `./${fileRel}` === `./${MOVES[possibleOldName]}${possibleOldName}`) {
      oldRel = `./${possibleOldName}`;
      newRel = `./${fileRel}`;
    } else {
      oldRel = `./${fileRel}`;
      newRel = `./${fileRel}`;
    }
  }

  const absPath = resolve(ROOT, fileRel);
  if (!existsSync(absPath)) continue;

  let content = readFileSync(absPath, "utf8");
  let changed = false;

  // Rewrite static imports
  content = content.replace(STATIC_RE, (match, prefix, spec, suffix) => {
    const newSpec = rewriteImport(oldRel, newRel, spec);
    if (newSpec !== spec) {
      changed = true;
      importsRewritten++;
      return `${prefix}${newSpec}${suffix}`;
    }
    return match;
  });

  // Rewrite dynamic imports
  content = content.replace(DYNAMIC_RE, (match, prefix, spec, suffix) => {
    const newSpec = rewriteImport(oldRel, newRel, spec);
    if (newSpec !== spec) {
      changed = true;
      importsRewritten++;
      return `${prefix}${newSpec}${suffix}`;
    }
    return match;
  });

  // Rewrite resolve(process.cwd(), "...") in test files
  if (fileRel.startsWith("tests/") || fileRel.startsWith("tests\\")) {
    content = content.replace(RESOLVE_CWD_RE, (match, prefix, filename, suffix) => {
      const key = `./${filename}`;
      const mapped = pathMap.get(key);
      if (mapped) {
        const newFilename = mapped.slice(2); // strip "./"
        changed = true;
        importsRewritten++;
        return `${prefix}${newFilename}${suffix}`;
      }
      return match;
    });

    // Rewrite resolve(dir, "..", "filename.mjs") pattern
    // Tests use: const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
    // Then:      path.resolve(dir, "..", "filename.mjs")
    // dir = tests/, so ".." = root, and "filename.mjs" is the root-level file
    content = content.replace(RESOLVE_DIR_PARENT_RE, (match, prefix, filename, suffix) => {
      const key = `./${filename}`;
      const mapped = pathMap.get(key);
      if (mapped) {
        // New path is relative from root, but the dir is tests/
        // resolve(dir, "..", "folder/filename.mjs") still works correctly
        const newFilename = mapped.slice(2); // strip "./"
        changed = true;
        importsRewritten++;
        return `${prefix}${newFilename}${suffix}`;
      }
      return match;
    });
  }

  if (changed) {
    filesChanged++;
    if (!DRY) writeFileSync(absPath, content, "utf8");
    console.log(`  ✓ ${fileRel} (imports rewritten)`);
  }
}

console.log(`\n  Files changed: ${filesChanged}, imports rewritten: ${importsRewritten}`);

// ─── step 4: update package.json ──────────────────────────────────────────
console.log("\n=== Updating package.json ===");

const pkgPath = resolve(ROOT, "package.json");
let pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

// Update exports
if (pkg.exports) {
  const newExports = {};
  for (const [key, val] of Object.entries(pkg.exports)) {
    const mapped = pathMap.get(val);
    newExports[key] = mapped || val;
  }
  pkg.exports = newExports;
  console.log("  ✓ exports updated");
}

// Update bin
if (pkg.bin) {
  const newBin = {};
  for (const [key, val] of Object.entries(pkg.bin)) {
    const mapped = pathMap.get(`./${val}`);
    newBin[key] = mapped ? mapped.slice(2) : val; // strip "./"
  }
  pkg.bin = newBin;
  console.log("  ✓ bin updated");
}

// Update files array
if (pkg.files) {
  const newFiles = pkg.files.map(f => {
    const mapped = pathMap.get(`./${f}`);
    return mapped ? mapped.slice(2) : f;
  });
  pkg.files = newFiles;
  console.log("  ✓ files updated");
}

// Update scripts
if (pkg.scripts) {
  const newScripts = {};
  for (const [key, val] of Object.entries(pkg.scripts)) {
    let newVal = val;
    // Replace "node filename.mjs" → "node folder/filename.mjs"
    for (const [oldFile, folder] of Object.entries(MOVES)) {
      // Word-boundary safe replacement
      const re = new RegExp(`(\\b)${oldFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b)`, "g");
      newVal = newVal.replace(re, `$1${folder}${oldFile}$2`);
    }
    newScripts[key] = newVal;
  }
  pkg.scripts = newScripts;
  console.log("  ✓ scripts updated");
}

if (!DRY) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

console.log("\n=== Migration complete ===");
if (DRY) console.log("  (DRY RUN — no files were changed)");
else console.log("  Run `npm test` to verify everything works.");
