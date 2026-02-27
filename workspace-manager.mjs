/**
 * workspace-manager.mjs — Multi-repo workspace management for Bosun
 *
 * Manages workspace directories under ~/bosun/workspaces/<name>/
 * Each workspace contains 1..N git repositories cloned from remote URLs.
 *
 * Config schema in bosun.config.json:
 *   "workspaces": [
 *     {
 *       "id": "virtengine",
 *       "name": "VirtEngine",
 *       "repos": [
 *         { "name": "virtengine", "url": "git@github.com:virtengine/virtengine.git", "slug": "virtengine/virtengine", "primary": true },
 *         { "name": "bosun", "url": "git@github.com:virtengine/bosun.git", "slug": "virtengine/bosun" }
 *       ],
 *       "createdAt": "2025-01-01T00:00:00.000Z",
 *       "activeRepo": "virtengine"
 *     }
 *   ],
 *   "activeWorkspace": "virtengine"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { createRequire } from "node:module";

const TAG = "[workspace-manager]";

const _childProcessRequire = createRequire(import.meta.url);
let _childProcessModule = null;
function getChildProcess() {
  if (!_childProcessModule) {
    _childProcessModule = _childProcessRequire("node:child_process");
  }
  return _childProcessModule;
}

// Lazy-loaded reference to repo-config.mjs (resolved on first use)
let _repoConfigModule = null;

/**
 * Ensure repo-level AI executor configs exist after clone/pull.
 * Uses synchronous import cache — repo-config.mjs is pure sync.
 * @param {string} repoPath  Absolute path to the repo directory
 */
function ensureRepoAIConfigs(repoPath) {
  try {
    if (!_repoConfigModule) {
      // repo-config.mjs is ESM but fully synchronous internally.
      // We pre-populate the cache via dynamic import at module init.
      return; // Will be populated after first async import
    }
    const { ensureRepoConfigs, printRepoConfigSummary } = _repoConfigModule;
    const result = ensureRepoConfigs(repoPath);
    // Only log if something was created/updated
    const anyChange = Object.values(result).some((r) => r.created || r.updated);
    if (anyChange) {
      console.log(TAG, `Repo-level AI configs for ${basename(repoPath)}:`);
      printRepoConfigSummary(result, (msg) => console.log(TAG, msg));
    }
  } catch (err) {
    console.warn(TAG, `Could not ensure repo AI configs: ${err.message}`);
  }
}

// Pre-load repo-config.mjs asynchronously at module init time
import("./repo-config.mjs")
  .then((mod) => { _repoConfigModule = mod; })
  .catch(() => { /* repo-config not available — skip */ });

// ── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Get the base workspaces directory.
 * @param {string} configDir - The bosun config directory (e.g. ~/bosun)
 * @returns {string} Path to workspaces directory
 */
export function getWorkspacesDir(configDir) {
  return resolve(configDir, "workspaces");
}

/**
 * Get the path for a specific workspace.
 * @param {string} configDir
 * @param {string} workspaceId
 * @returns {string}
 */
export function getWorkspacePath(configDir, workspaceId) {
  return resolve(getWorkspacesDir(configDir), workspaceId);
}

/**
 * Get the path for a repo within a workspace.
 * @param {string} configDir
 * @param {string} workspaceId
 * @param {string} repoName
 * @returns {string}
 */
export function getRepoPath(configDir, workspaceId, repoName) {
  return resolve(getWorkspacePath(configDir, workspaceId), repoName);
}

// ── ID/Slug Helpers ──────────────────────────────────────────────────────────

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractRepoName(url) {
  if (!url) return "";
  // Handle SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/[/:]([^/]+)\.git$/);
  if (sshMatch) return sshMatch[1];
  // Handle HTTPS: https://github.com/org/repo.git or https://github.com/org/repo
  const httpsMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  return basename(url).replace(/\.git$/, "");
}

function extractSlug(url) {
  if (!url) return "";
  // git@github.com:org/repo.git → org/repo
  const sshMatch = url.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  // https://github.com/org/repo.git → org/repo
  const httpsMatch = url.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  return "";
}

// ── Config Management ────────────────────────────────────────────────────────

const CONFIG_FILE = "bosun.config.json";

function loadBosunConfig(configDir) {
  const configPath = resolve(configDir, CONFIG_FILE);
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function saveBosunConfig(configDir, config) {
  const configPath = resolve(configDir, CONFIG_FILE);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getWorkspacesFromConfig(configDir) {
  const config = loadBosunConfig(configDir);
  return Array.isArray(config.workspaces) ? config.workspaces : [];
}

function saveWorkspacesToConfig(configDir, workspaces, activeWorkspace) {
  const config = loadBosunConfig(configDir);
  config.workspaces = workspaces;
  if (activeWorkspace !== undefined) {
    config.activeWorkspace = activeWorkspace;
  }
  saveBosunConfig(configDir, config);
}

// ── Workspace CRUD ───────────────────────────────────────────────────────────

/**
 * List all workspaces with their repos.
 * @param {string} configDir
 * @param {{ repoRoot?: string }} [opts]  Optional overrides.  When `repoRoot` is
 *   provided, repos that don't exist under the workspace directory are also checked
 *   against `<repoRoot>/<repoName>` so that local development repos surface as
 *   "existing" rather than "missing".
 * @returns {Array<{id: string, name: string, path: string, repos: Array, createdAt: string, activeRepo: string}>}
 */
export function listWorkspaces(configDir, opts = {}) {
  const workspaces = getWorkspacesFromConfig(configDir);
  const wsDir = getWorkspacesDir(configDir);
  const repoRootOverride = opts.repoRoot || null;

  return workspaces.map((ws) => {
    const wsPath = resolve(wsDir, ws.id);
    const repos = (ws.repos || []).map((repo) => {
      const standardPath = resolve(wsPath, repo.name);
      const standardExists = existsSync(standardPath);
      let effectivePath = standardPath;
      let exists = standardExists;
      if (!standardExists && repoRootOverride) {
        const altPath = resolve(repoRootOverride, repo.name);
        if (existsSync(altPath)) {
          effectivePath = altPath;
          exists = true;
        }
      }
      return {
        ...repo,
        path: effectivePath,
        exists,
      };
    });
    const wsExists = existsSync(wsPath) || repos.some((r) => r.exists);
    return {
      ...ws,
      path: wsPath,
      exists: wsExists,
      repos,
    };
  });
}

/**
 * Get a workspace by ID.
 * @param {string} configDir
 * @param {string} workspaceId
 * @returns {Object|null}
 */
export function getWorkspace(configDir, workspaceId) {
  const all = listWorkspaces(configDir);
  const id = normalizeId(workspaceId);
  return all.find((ws) => ws.id === id) || null;
}

/**
 * Get the currently active workspace.
 * @param {string} configDir
 * @returns {Object|null}
 */
export function getActiveWorkspace(configDir) {
  const config = loadBosunConfig(configDir);
  const activeId = config.activeWorkspace || "";
  if (!activeId) {
    const workspaces = listWorkspaces(configDir);
    return workspaces[0] || null;
  }
  return getWorkspace(configDir, activeId);
}

/**
 * Create a new workspace.
 * @param {string} configDir
 * @param {{name: string, id?: string}} options
 * @returns {{id: string, name: string, path: string, repos: Array}}
 */
export function createWorkspace(configDir, { name, id }) {
  const wsId = normalizeId(id || name);
  if (!wsId) throw new Error("Workspace name is required");

  const workspaces = getWorkspacesFromConfig(configDir);
  if (workspaces.some((ws) => normalizeId(ws.id) === wsId)) {
    throw new Error(`Workspace "${wsId}" already exists`);
  }

  const wsPath = getWorkspacePath(configDir, wsId);
  mkdirSync(wsPath, { recursive: true });

  const workspace = {
    id: wsId,
    name: name || wsId,
    repos: [],
    createdAt: new Date().toISOString(),
    activeRepo: null,
  };

  workspaces.push(workspace);

  // If this is the first workspace, make it active
  const config = loadBosunConfig(configDir);
  const isFirst = workspaces.length === 1;
  saveWorkspacesToConfig(configDir, workspaces, isFirst ? wsId : config.activeWorkspace);

  console.log(TAG, `Created workspace "${name}" at ${wsPath}`);
  return { ...workspace, path: wsPath, exists: true, repos: [] };
}

/**
 * Remove a workspace and optionally delete its directory.
 * @param {string} configDir
 * @param {string} workspaceId
 * @param {{deleteFiles?: boolean}} options
 * @returns {boolean}
 */
export function removeWorkspace(configDir, workspaceId, { deleteFiles = false } = {}) {
  const wsId = normalizeId(workspaceId);
  const workspaces = getWorkspacesFromConfig(configDir);
  const idx = workspaces.findIndex((ws) => normalizeId(ws.id) === wsId);
  if (idx === -1) return false;

  workspaces.splice(idx, 1);

  const config = loadBosunConfig(configDir);
  const activeWs = config.activeWorkspace === wsId
    ? (workspaces[0]?.id || "")
    : config.activeWorkspace;
  saveWorkspacesToConfig(configDir, workspaces, activeWs);

  if (deleteFiles) {
    const wsPath = getWorkspacePath(configDir, wsId);
    if (existsSync(wsPath)) {
      rmSync(wsPath, { recursive: true, force: true });
      console.log(TAG, `Deleted workspace directory: ${wsPath}`);
    }
  }

  console.log(TAG, `Removed workspace "${wsId}"`);
  return true;
}

/**
 * Set the active workspace.
 * @param {string} configDir
 * @param {string} workspaceId
 * @returns {boolean}
 */
export function setActiveWorkspace(configDir, workspaceId) {
  const wsId = normalizeId(workspaceId);
  const workspaces = getWorkspacesFromConfig(configDir);
  if (!workspaces.some((ws) => normalizeId(ws.id) === wsId)) {
    throw new Error(`Workspace "${wsId}" not found`);
  }
  const config = loadBosunConfig(configDir);
  config.activeWorkspace = wsId;
  saveBosunConfig(configDir, config);
  console.log(TAG, `Active workspace set to "${wsId}"`);
  return true;
}

// ── Repo Management ──────────────────────────────────────────────────────────

/**
 * Add a repo to a workspace by cloning from a URL.
 * @param {string} configDir
 * @param {string} workspaceId
 * @param {{url: string, name?: string, branch?: string, primary?: boolean}} options
 * @returns {{name: string, path: string, slug: string, url: string, cloned: boolean}}
 */
export function addRepoToWorkspace(configDir, workspaceId, { url, name, branch, primary = false }) {
  const wsId = normalizeId(workspaceId);
  const workspaces = getWorkspacesFromConfig(configDir);
  const wsIdx = workspaces.findIndex((ws) => normalizeId(ws.id) === wsId);
  if (wsIdx === -1) throw new Error(`Workspace "${wsId}" not found`);

  const repoName = name || extractRepoName(url);
  if (!repoName) throw new Error("Could not determine repository name from URL");

  const ws = workspaces[wsIdx];
  if ((ws.repos || []).some((r) => r.name === repoName)) {
    throw new Error(`Repository "${repoName}" already exists in workspace "${wsId}"`);
  }

  const wsPath = getWorkspacePath(configDir, wsId);
  const repoPath = resolve(wsPath, repoName);
  const childProcess = getChildProcess();
  let cloned = false;

  if (!existsSync(repoPath)) {
    mkdirSync(wsPath, { recursive: true });
    console.log(TAG, `Cloning ${url} into ${repoPath}...`);
    const cloneArgs = ["clone"];
    if (branch) cloneArgs.push("--branch", branch);
    cloneArgs.push(url, repoPath);

    const result = childProcess.spawnSync("git", cloneArgs, {
      encoding: "utf8",
      timeout: 300000, // 5 minutes
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.status !== 0) {
      throw new Error(`git clone failed: ${result.stderr || result.error?.message || "unknown error"}`);
    }
    cloned = true;
    console.log(TAG, `Cloned ${repoName} successfully`);
    // Ensure repo-level AI executor configs exist after fresh clone
    ensureRepoAIConfigs(repoPath);
  } else {
    console.log(TAG, `Repository ${repoName} already exists at ${repoPath}`);
    // Ensure repo-level configs are up to date even for existing repos
    ensureRepoAIConfigs(repoPath);
  }

  const slug = extractSlug(url);
  const repoEntry = {
    name: repoName,
    url,
    slug,
    primary: primary || (ws.repos || []).length === 0,
  };

  if (!ws.repos) ws.repos = [];
  ws.repos.push(repoEntry);

  // If this is primary or first repo, set as activeRepo
  if (repoEntry.primary || !ws.activeRepo) {
    ws.activeRepo = repoName;
  }

  saveWorkspacesToConfig(configDir, workspaces);

  return {
    ...repoEntry,
    path: repoPath,
    cloned,
    exists: existsSync(repoPath),
  };
}

/**
 * Remove a repo from a workspace.
 * @param {string} configDir
 * @param {string} workspaceId
 * @param {string} repoName
 * @param {{deleteFiles?: boolean}} options
 * @returns {boolean}
 */
export function removeRepoFromWorkspace(configDir, workspaceId, repoName, { deleteFiles = false } = {}) {
  const wsId = normalizeId(workspaceId);
  const workspaces = getWorkspacesFromConfig(configDir);
  const wsIdx = workspaces.findIndex((ws) => normalizeId(ws.id) === wsId);
  if (wsIdx === -1) return false;

  const ws = workspaces[wsIdx];
  const repoIdx = (ws.repos || []).findIndex((r) => r.name === repoName);
  if (repoIdx === -1) return false;

  ws.repos.splice(repoIdx, 1);

  if (ws.activeRepo === repoName) {
    ws.activeRepo = ws.repos[0]?.name || null;
  }

  saveWorkspacesToConfig(configDir, workspaces);

  if (deleteFiles) {
    const repoPath = getRepoPath(configDir, wsId, repoName);
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  }

  return true;
}

/**
 * Set the active repo within a workspace.
 * @param {string} configDir
 * @param {string} workspaceId
 * @param {string} repoName
 * @returns {boolean}
 */
export function setActiveRepo(configDir, workspaceId, repoName) {
  const wsId = normalizeId(workspaceId);
  const workspaces = getWorkspacesFromConfig(configDir);
  const ws = workspaces.find((w) => normalizeId(w.id) === wsId);
  if (!ws) return false;
  if (!(ws.repos || []).some((r) => r.name === repoName)) return false;

  ws.activeRepo = repoName;
  saveWorkspacesToConfig(configDir, workspaces);
  return true;
}

/**
 * Pull latest changes for all repos in a workspace.
 * @param {string} configDir
 * @param {string} workspaceId
 * @returns {Array<{name: string, success: boolean, error?: string}>}
 */
export function pullWorkspaceRepos(configDir, workspaceId) {
  const ws = getWorkspace(configDir, workspaceId);
  if (!ws) throw new Error(`Workspace "${workspaceId}" not found`);
  const childProcess = getChildProcess();

  const results = [];
  for (const repo of ws.repos || []) {
    const repoPath = resolve(ws.path, repo.name);
    if (!existsSync(repoPath)) {
      const repoUrl =
        repo.url ||
        (repo.slug ? `https://github.com/${repo.slug.replace(/\.git$/i, "")}.git` : "");
      if (!repoUrl) {
        results.push({
          name: repo.name,
          success: false,
          error: "Directory not found and repo URL is missing",
        });
        continue;
      }
      try {
        mkdirSync(ws.path, { recursive: true });
        console.log(TAG, `Cloning ${repoUrl} into ${repoPath}...`);
        const clone = childProcess.spawnSync("git", ["clone", repoUrl, repoPath], {
          encoding: "utf8",
          timeout: 300000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (clone.status !== 0) {
          const stderr = String(clone.stderr || clone.stdout || "");
          let hint = "";
          if (/permission denied \(publickey\)/i.test(stderr)) {
            hint =
              "SSH auth failed. Configure SSH keys or use an HTTPS URL instead.";
          } else if (/authentication failed|fatal: authentication failed/i.test(stderr)) {
            hint =
              "HTTPS auth failed. Use a PAT/credential helper or switch to SSH.";
          } else if (/repository .* not found|not found/i.test(stderr)) {
            hint =
              "Repository not found or access denied. Verify the org/repo and permissions.";
          }
          results.push({
            name: repo.name,
            success: false,
            error: `git clone failed (${repoUrl}): ${
              stderr || clone.error?.message || "unknown error"
            }${hint ? ` — ${hint}` : ""}`,
          });
          continue;
        }
        console.log(TAG, `Cloned ${repo.name} successfully`);
      } catch (err) {
        results.push({
          name: repo.name,
          success: false,
          error: `git clone failed (${repoUrl}): ${err.message || err}`,
        });
        continue;
      }
    }
    const gitDir = resolve(repoPath, ".git");
    if (!existsSync(gitDir)) {
      try {
        const contents = existsSync(repoPath) ? readdirSync(repoPath) : [];
        const isEmpty = contents.length === 0;
        const repoUrl =
          repo.url ||
          (repo.slug ? `https://github.com/${repo.slug.replace(/\.git$/i, "")}.git` : "");
        if (isEmpty && repoUrl) {
          console.log(TAG, `Cloning ${repoUrl} into existing empty directory ${repoPath}...`);
          const clone = childProcess.spawnSync("git", ["clone", repoUrl, "."], {
            encoding: "utf8",
            timeout: 300000,
            stdio: ["pipe", "pipe", "pipe"],
            cwd: repoPath,
          });
          if (clone.status !== 0) {
            const stderr = String(clone.stderr || clone.stdout || "");
            results.push({
              name: repo.name,
              success: false,
              error: `git clone failed (${repoUrl}): ${stderr || clone.error?.message || "unknown error"}`,
            });
            continue;
          }
        } else {
          results.push({
            name: repo.name,
            success: false,
            error: "Directory exists but is not a git repository",
          });
          continue;
        }
      } catch (err) {
        results.push({
          name: repo.name,
          success: false,
          error: `Directory check failed: ${err.message || err}`,
        });
        continue;
      }
    }
    try {
      childProcess.execSync("git pull --rebase", {
        cwd: repoPath,
        encoding: "utf8",
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      results.push({ name: repo.name, success: true });
    } catch (err) {
      const details = String(err?.stderr || err?.stdout || err?.message || err || "")
        .replace(/\s+/g, " ")
        .trim();
      results.push({
        name: repo.name,
        success: false,
        error: details || "git pull --rebase failed",
      });
    }
  }
  return results;
}

/**
 * Get workspace-scoped repositories in the format expected by loadRepoConfig.
 * Returns config.repositories-compatible array for the active workspace.
 * @param {string} configDir
 * @returns {Array}
 */
export function getWorkspaceRepositories(configDir, workspaceId = "") {
  const ws = workspaceId
    ? getWorkspace(configDir, workspaceId)
    : getActiveWorkspace(configDir);
  if (!ws || !ws.repos?.length) return [];

  return ws.repos.map((repo) => ({
    name: repo.name,
    id: normalizeId(repo.name),
    path: resolve(ws.path, repo.name),
    slug: repo.slug || "",
    url: repo.url || "",
    primary: repo.primary || false,
    workspace: ws.id,
  }));
}

/**
 * Merge filesystem-detected workspaces into persisted config without cloning.
 * Useful when operators manually add folders under $BOSUN_DIR/workspaces.
 * @param {string} configDir
 * @returns {{workspaces: Array, added: number, updated: number, scanned: number}}
 */
export function mergeDetectedWorkspaces(configDir) {
  const detected = detectWorkspaces(configDir);
  const workspaces = getWorkspacesFromConfig(configDir);
  const byId = new Map(
    workspaces.map((ws) => [normalizeId(ws.id), ws]),
  );

  let added = 0;
  let updated = 0;

  for (const ws of detected) {
    const wsId = normalizeId(ws.id);
    const existing = byId.get(wsId);
    if (!existing) {
      workspaces.push({
        id: wsId,
        name: ws.name || ws.id || wsId,
        repos: ws.repos || [],
        createdAt: ws.createdAt || new Date().toISOString(),
        activeRepo:
          ws.activeRepo ||
          ws.repos?.find((repo) => repo.primary)?.name ||
          ws.repos?.[0]?.name ||
          null,
      });
      byId.set(wsId, workspaces[workspaces.length - 1]);
      added += 1;
      continue;
    }

    const existingRepos = Array.isArray(existing.repos) ? existing.repos : [];
    const existingRepoMap = new Map(existingRepos.map((repo) => [repo.name, repo]));
    let changed = false;

    for (const repo of ws.repos || []) {
      if (!repo?.name) continue;
      const current = existingRepoMap.get(repo.name);
      if (!current) {
        existingRepos.push({
          ...repo,
          primary: repo.primary === true || existingRepos.length === 0,
        });
        changed = true;
        continue;
      }
      if (!current.slug && repo.slug) {
        current.slug = repo.slug;
        changed = true;
      }
      if (!current.url && repo.url) {
        current.url = repo.url;
        changed = true;
      }
    }

    existing.repos = existingRepos;
    if (!existing.activeRepo) {
      existing.activeRepo =
        existing.repos.find((repo) => repo.primary)?.name ||
        existing.repos[0]?.name ||
        null;
      changed = true;
    }
    if (changed) updated += 1;
  }

  if (added > 0 || updated > 0) {
    const config = loadBosunConfig(configDir);
    const activeWorkspace =
      config.activeWorkspace || workspaces[0]?.id || "";
    saveWorkspacesToConfig(configDir, workspaces, activeWorkspace);
  }

  return {
    workspaces: listWorkspaces(configDir),
    added,
    updated,
    scanned: detected.length,
  };
}

/**
 * Auto-detect workspaces from existing directory structure.
 * Useful for initial setup when workspaces/ dir already has cloned repos.
 * @param {string} configDir
 * @returns {Array<{id: string, name: string, repos: Array}>}
 */
export function detectWorkspaces(configDir) {
  const wsDir = getWorkspacesDir(configDir);
  if (!existsSync(wsDir)) return [];

  const detected = [];
  const childProcess = getChildProcess();
  for (const entry of readdirSync(wsDir)) {
    const entryPath = resolve(wsDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const repos = [];
    for (const sub of readdirSync(entryPath)) {
      const subPath = resolve(entryPath, sub);
      if (!statSync(subPath).isDirectory()) continue;
      if (existsSync(resolve(subPath, ".git"))) {
        let slug = "";
        try {
          const remote = childProcess.execSync("git remote get-url origin", {
            cwd: subPath,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
          }).trim();
          slug = extractSlug(remote);
        } catch { /* no remote */ }
        repos.push({
          name: sub,
          slug,
          url: "",
          primary: repos.length === 0,
        });
      }
    }

    if (repos.length > 0) {
      detected.push({
        id: normalizeId(entry),
        name: entry,
        repos,
        createdAt: new Date().toISOString(),
        activeRepo: repos[0]?.name || null,
      });
    }
  }

  return detected;
}

/**
 * Initialize workspaces from detection or existing config.
 * Called during setup or first run.
 * @param {string} configDir
 * @returns {{workspaces: Array, isNew: boolean}}
 */
export function initializeWorkspaces(configDir, opts = {}) {
  const existing = getWorkspacesFromConfig(configDir);
  if (existing.length > 0) {
    return { workspaces: listWorkspaces(configDir, opts), isNew: false };
  }

  // Try auto-detection
  const detected = detectWorkspaces(configDir);
  if (detected.length > 0) {
    saveWorkspacesToConfig(configDir, detected, detected[0].id);
    return { workspaces: listWorkspaces(configDir, opts), isNew: true };
  }

  return { workspaces: [], isNew: true };
}
