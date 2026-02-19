#!/usr/bin/env node
/**
 * git-editor-fix.mjs — Prevent agents from opening interactive editors
 *
 * Problem: Agents inherit user's git config which uses VSCode (`code --wait`)
 * Result: Git operations block waiting for editor, freezing agents
 *
 * Solution: Set GIT_EDITOR=true (or GIT_EDITOR=:) for non-interactive mode
 *
 * This script ensures all agent workspaces have non-blocking git config.
 * Covers: main repo, tmpclaude-* workspaces, git worktrees (ve/*),
 *         and VK task worktrees under $TEMP/vibe-kanban/worktrees/.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { resolveRepoRoot } from "./repo-root.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolveRepoRoot();

/**
 * Configure git to never open interactive editors
 * @param {string} workspacePath - Path to workspace directory
 * @returns {boolean} true if configured successfully
 */
function configureNonInteractiveGit(workspacePath) {
  const gitDir = resolve(workspacePath, ".git");

  // .git can be a file (worktree link) or a directory — both are valid
  if (!existsSync(gitDir)) {
    console.warn(`[git-editor-fix] No .git entry at ${workspacePath}`);
    return false;
  }

  try {
    // Set local git config for this workspace
    // Use ':' (colon) as no-op editor — POSIX standard that always succeeds
    execSync("git config --local core.editor :", {
      cwd: workspacePath,
      stdio: "pipe",
    });

    // Also disable merge commit editor prompts
    execSync("git config --local merge.commit.autoEdit no", {
      cwd: workspacePath,
      stdio: "pipe",
    });

    console.log(
      `[git-editor-fix] ✓ Configured ${workspacePath} for non-interactive git`,
    );
    return true;
  } catch (err) {
    console.error(
      `[git-editor-fix] Failed to configure ${workspacePath}:`,
      err.message,
    );
    return false;
  }
}

// ── Workspace discovery helpers ──────────────────────────────────────────────

/**
 * Collect tmpclaude-* directories under REPO_ROOT
 * @returns {string[]}
 */
function findTmpclaudeWorkspaces() {
  /** @type {string[]} */
  const results = [];
  try {
    const entries = readdirSync(REPO_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("tmpclaude-")) {
        results.push(resolve(REPO_ROOT, entry.name));
      }
    }
  } catch (err) {
    console.error(
      "[git-editor-fix] Failed to scan tmpclaude workspaces:",
      err.message,
    );
  }
  return results;
}

/**
 * Parse `git worktree list --porcelain` and return paths of ve/* worktrees
 * @returns {string[]}
 */
function findGitWorktrees() {
  /** @type {string[]} */
  const results = [];
  try {
    const raw = execSync("git worktree list --porcelain", {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });

    // Porcelain output has blocks separated by blank lines.
    // Each block starts with "worktree <path>".
    // We also look for "branch refs/heads/ve/..." to identify VK worktrees,
    // but we include ALL worktrees — they all need the fix.
    for (const line of raw.split("\n")) {
      const match = line.match(/^worktree\s+(.+)$/);
      if (match) {
        const wtPath = match[1].trim();
        // Skip the bare repo entry if present
        if (existsSync(resolve(wtPath, ".git"))) {
          results.push(wtPath);
        }
      }
    }
  } catch (err) {
    // git worktree list fails if the repo has no worktrees — that's fine
    if (!String(err.message).includes("is not a git repository")) {
      console.warn(
        "[git-editor-fix] Could not enumerate git worktrees:",
        err.message,
      );
    }
  }
  return results;
}

/**
 * Scan $TEMP/vibe-kanban/worktrees/ for VK task worktree directories
 * @returns {string[]}
 */
function findVKWorktrees() {
  /** @type {string[]} */
  const results = [];
  const vkBase = resolve(tmpdir(), "vibe-kanban", "worktrees");

  if (!existsSync(vkBase)) {
    return results;
  }

  try {
    const entries = readdirSync(vkBase, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = resolve(vkBase, entry.name);
        if (existsSync(resolve(candidate, ".git"))) {
          results.push(candidate);
        }
      }
    }
  } catch (err) {
    console.error("[git-editor-fix] Failed to scan VK worktrees:", err.message);
  }
  return results;
}

// ── Main functions ───────────────────────────────────────────────────────────

/**
 * Scan for all agent workspaces and fix git config.
 * Sources:
 *   1. Main repo root (REPO_ROOT)
 *   2. tmpclaude-* directories
 *   3. git worktrees (parsed from `git worktree list --porcelain`)
 *   4. VK task worktrees under $TEMP/vibe-kanban/worktrees/
 *
 * Paths are deduplicated before configuration.
 */
function fixAllWorkspaces() {
  console.log("[git-editor-fix] Scanning for agent workspaces...");

  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {string} p */
  const add = (p) => {
    const normalized = resolve(p);
    seen.add(normalized);
  };

  // 1. Main repo root
  add(REPO_ROOT);

  // 2. tmpclaude-* directories
  for (const ws of findTmpclaudeWorkspaces()) {
    add(ws);
  }

  // 3. Git worktrees (includes ve/* branches)
  for (const ws of findGitWorktrees()) {
    add(ws);
  }

  // 4. VK worktrees under $TEMP
  for (const ws of findVKWorktrees()) {
    add(ws);
  }

  const workspaces = [...seen];
  console.log(
    `[git-editor-fix] Found ${workspaces.length} workspace(s) to configure`,
  );

  let fixed = 0;
  for (const ws of workspaces) {
    if (configureNonInteractiveGit(ws)) {
      fixed++;
    }
  }

  console.log(
    `[git-editor-fix] ✓ Fixed ${fixed}/${workspaces.length} workspaces`,
  );
}

/**
 * Convenience wrapper: configure the main repo and all discoverable worktrees
 * in a single call. Suitable for use from other modules.
 * @returns {{ fixed: number, total: number }}
 */
function configureRepoAndWorktrees() {
  console.log("[git-editor-fix] Configuring repo and all worktrees...");

  /** @type {Set<string>} */
  const seen = new Set();

  const add = (/** @type {string} */ p) => seen.add(resolve(p));

  add(REPO_ROOT);
  findTmpclaudeWorkspaces().forEach(add);
  findGitWorktrees().forEach(add);
  findVKWorktrees().forEach(add);

  const workspaces = [...seen];
  let fixed = 0;
  for (const ws of workspaces) {
    if (configureNonInteractiveGit(ws)) {
      fixed++;
    }
  }

  console.log(
    `[git-editor-fix] ✓ Configured ${fixed}/${workspaces.length} workspace(s)`,
  );
  return { fixed, total: workspaces.length };
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

const isMainModule = () => {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    return process.argv[1] === modulePath;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  fixAllWorkspaces();
}

export {
  configureNonInteractiveGit,
  fixAllWorkspaces,
  configureRepoAndWorktrees,
  findGitWorktrees,
  findVKWorktrees,
  findTmpclaudeWorkspaces,
};
