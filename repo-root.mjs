import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the repo root for bosun.
 *
 * Priority:
 *  1. Explicit REPO_ROOT env var.
 *  2. git rev-parse --show-toplevel (relative to cwd).
 *  3. git rev-parse --show-toplevel from the bosun package directory.
 *  4. Workspace config repo path (bosun.config.json).
 *  5. process.cwd().
 */
export function resolveRepoRoot(options = {}) {
  const envRoot = process.env.REPO_ROOT;
  if (envRoot) return resolve(envRoot);

  const cwd = options.cwd || process.cwd();

  // Try git from cwd
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // ignore - fall back
  }

  // Try git from the bosun package directory (may be inside a repo)
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // bosun installed standalone
  }

  // Check bosun config for workspace repos
  const CONFIG_FILES = ["bosun.config.json", ".bosun.json", "bosun.json"];
  const configDir = process.env.BOSUN_DIR || resolve(process.env.HOME || process.env.USERPROFILE || "", "bosun");
  for (const cfgName of CONFIG_FILES) {
    // Check both the configDir and __dirname (package dir)
    for (const dir of [configDir, __dirname]) {
      const cfgPath = resolve(dir, cfgName);
      if (existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
          const repos = cfg.repositories || cfg.repos || [];
          if (Array.isArray(repos) && repos.length > 0) {
            const primary = repos.find((r) => r.primary) || repos[0];
            const repoPath = primary?.path || primary?.repoRoot;
            if (repoPath && existsSync(resolve(repoPath))) return resolve(repoPath);
          }
        } catch { /* invalid config */ }
      }
    }
  }

  return resolve(cwd);
}
