import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

export function runWorkspaceHealthCheck(options = {}) {
  const configDir = options.configDir || process.env.BOSUN_DIR || join(homedir(), "bosun");
    const issues = { errors: [], warnings: [], infos: [] };
  const workspaceResults = [];

  // 1. Check if workspaces are configured
  let workspaces = [];
  try {
    const configPath = join(configDir, "bosun.config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      workspaces = config.workspaces || [];
    }
  } catch (err) {
    issues.errors.push({
      code: "WS_CONFIG_READ_FAILED",
      message: `Failed to read workspace config: ${err.message}`,
      fix: "Check bosun.config.json is valid JSON",
    });
  }

  if (workspaces.length === 0) {
    issues.infos.push({
      code: "WS_NONE_CONFIGURED",
      message: "No workspaces configured — agents use developer repo directly.",
      fix: "Run 'bosun --workspace-add <name>' to create a workspace for isolated agent execution.",
    });
    return { ok: true, workspaces: workspaceResults, issues };
  }

  // 2. Check each workspace
  for (const ws of workspaces) {
    const wsResult = {
      id: ws.id || "unknown",
      name: ws.name || ws.id || "unnamed",
      path: ws.path || "",
      repos: [],
      ok: true,
    };

    // 2a. Workspace directory exists
    const wsPath = ws.path || join(configDir, "workspaces", ws.id || ws.name);
    if (!existsSync(wsPath)) {
      issues.warnings.push({
        code: "WS_DIR_MISSING",
        message: `Workspace "${wsResult.name}" directory missing: ${wsPath}`,
        fix: `Run 'bosun --setup' or mkdir -p "${wsPath}"`,
      });
      wsResult.ok = false;
    }

    // 2b. Check repos in workspace
    for (const repo of ws.repos || []) {
      const repoName = repo.name || repo.slug || "unknown";
      const repoPath = join(wsPath, repoName);
      const repoStatus = { name: repoName, path: repoPath, ok: true, issues: [] };

      if (!existsSync(repoPath)) {
        repoStatus.ok = false;
        repoStatus.issues.push("directory missing");
        issues.errors.push({
          code: "WS_REPO_MISSING",
          message: `Workspace repo "${repoName}" not found at ${repoPath}`,
          fix: `Run 'bosun --workspace-add-repo <url>' or 'bosun --setup' to clone it`,
        });
      } else {
        const gitPath = join(repoPath, ".git");
        if (!existsSync(gitPath)) {
          repoStatus.ok = false;
          repoStatus.issues.push(".git missing");
          issues.errors.push({
            code: "WS_REPO_NO_GIT",
            message: `Workspace repo "${repoName}" has no .git at ${repoPath}`,
            fix: `Clone the repo: git clone <url> "${repoPath}"`,
          });
        } else {
          // Check remote connectivity (quick)
          try {
            const branch = execSync("git rev-parse --abbrev-ref HEAD", {
              cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            repoStatus.branch = branch;
            repoStatus.issues.push(`on branch: ${branch}`);
          } catch {
            repoStatus.issues.push("git status check failed");
          }

          // Check for uncommitted changes
          try {
            const status = execSync("git status --porcelain", {
              cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            if (status) {
              const lines = status.split("\n").length;
              repoStatus.issues.push(`${lines} uncommitted change(s)`);
              issues.infos.push({
                code: "WS_REPO_DIRTY",
                message: `Workspace repo "${repoName}" has ${lines} uncommitted change(s)`,
                fix: null,
              });
            }
          } catch { /* ignore */ }
        }
      }

      wsResult.repos.push(repoStatus);
      if (!repoStatus.ok) wsResult.ok = false;
    }

    workspaceResults.push(wsResult);
  }

  // 3. Check Codex sandbox writable_roots coverage
  const codexConfigPath = join(homedir(), ".codex", "config.toml");
  if (existsSync(codexConfigPath)) {
    try {
      const toml = readFileSync(codexConfigPath, "utf8");
      const rootsMatch = toml.match(/writable_roots\s*=\s*\[([^\]]*)\]/);
      if (rootsMatch) {
        const roots = rootsMatch[1].split(",").map(r => r.trim().replace(/^"|"$/g, "")).filter(Boolean);
        for (const ws of workspaces) {
          const wsPath = ws.path || join(configDir, "workspaces", ws.id || ws.name);
          for (const repo of ws.repos || []) {
            const repoPath = join(wsPath, repo.name || repo.slug || "");
            const gitPath = join(repoPath, ".git");
            if (existsSync(gitPath) && !roots.some(r => gitPath.startsWith(r) || r === gitPath)) {
              issues.warnings.push({
                code: "WS_SANDBOX_MISSING_ROOT",
                message: `Workspace repo .git not in Codex writable_roots: ${gitPath}`,
                fix: `Run 'bosun --setup' to update Codex sandbox config, or add "${gitPath}" to writable_roots in ~/.codex/config.toml`,
              });
            }
          }
        }

        // Check for phantom/relative writable roots
        for (const root of roots) {
          if (!root.startsWith("/")) {
            issues.warnings.push({
              code: "WS_SANDBOX_RELATIVE_ROOT",
              message: `Relative path in Codex writable_roots: "${root}" — may resolve incorrectly`,
              fix: `Remove "${root}" from writable_roots in ~/.codex/config.toml and run 'bosun --setup'`,
            });
          } else if (!existsSync(root) && root !== "/tmp") {
            issues.infos.push({
              code: "WS_SANDBOX_PHANTOM_ROOT",
              message: `Codex writable_root path does not exist: ${root}`,
              fix: null,
            });
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // 4. Check BOSUN_AGENT_REPO_ROOT
  const agentRoot = process.env.BOSUN_AGENT_REPO_ROOT || "";
  if (agentRoot) {
    if (!existsSync(agentRoot)) {
      issues.warnings.push({
        code: "WS_AGENT_ROOT_MISSING",
        message: `BOSUN_AGENT_REPO_ROOT points to non-existent path: ${agentRoot}`,
        fix: "Run 'bosun --setup' to bootstrap workspace repos",
      });
    } else if (!existsSync(join(agentRoot, ".git"))) {
      issues.warnings.push({
        code: "WS_AGENT_ROOT_NO_GIT",
        message: `BOSUN_AGENT_REPO_ROOT has no .git: ${agentRoot}`,
        fix: "Clone the repo at the workspace path or update BOSUN_AGENT_REPO_ROOT",
      });
    } else {
      issues.infos.push({
        code: "WS_AGENT_ROOT_OK",
        message: `Agent repo root: ${agentRoot}`,
        fix: null,
      });
    }
  }

  const hasErrors = issues.errors.length > 0;
  return { ok: !hasErrors, workspaces: workspaceResults, issues };
}

/**
 * Format workspace health report for CLI output.
 * @param {{ ok: boolean, workspaces: Array, issues: object }} result
 * @returns {string}
 */
export function formatWorkspaceHealthReport(result) {
  const lines = [];
  lines.push("=== bosun workspace health ===");
  lines.push(`Status: ${result.ok ? "HEALTHY" : "ISSUES FOUND"}`);
  lines.push("");

  if (result.workspaces.length === 0) {
    lines.push("  No workspaces configured.");
    lines.push("");
  }

  for (const ws of result.workspaces) {
    const icon = ws.ok ? "✓" : "✗";
    lines.push(`  ${icon} ${ws.name} (${ws.id})`);
    for (const repo of ws.repos) {
      const rIcon = repo.ok ? "✓" : "✗";
      const details = repo.issues.length > 0 ? ` — ${repo.issues.join(", ")}` : "";
      lines.push(`    ${rIcon} ${repo.name}${details}`);
    }
  }
  lines.push("");

  if (result.issues.errors.length > 0) {
    lines.push("Errors:");
    for (const e of result.issues.errors) {
      lines.push(`  ✗ ${e.message}`);
      if (e.fix) lines.push(`    fix: ${e.fix}`);
    }
    lines.push("");
  }
  if (result.issues.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.issues.warnings) {
      lines.push(`  :alert: ${w.message}`);
      if (w.fix) lines.push(`    fix: ${w.fix}`);
    }
    lines.push("");
  }
  if (result.issues.infos.length > 0) {
    lines.push("Info:");
    for (const i of result.issues.infos) {
      lines.push(`  :help: ${i.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

