import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Resolve the repo root for openfleet.
 *
 * Priority:
 *  1. Explicit REPO_ROOT env var.
 *  2. git rev-parse --show-toplevel (relative to cwd).
 *  3. process.cwd().
 */
export function resolveRepoRoot(options = {}) {
  const envRoot = process.env.REPO_ROOT;
  if (envRoot) return resolve(envRoot);

  const cwd = options.cwd || process.cwd();
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // ignore - fall back to cwd
  }

  return resolve(cwd);
}
