#!/usr/bin/env node

/**
 * bosun — Post-Install Environment Validator
 *
 * Runs after `npm install` to check for required system dependencies
 * that can't be installed via npm (git, gh, pwsh) and prints
 * actionable install instructions for anything missing.
 *
 * This is non-blocking — missing optional tools produce warnings,
 * not errors, so CI installs won't fail.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  rmSync,
  chmodSync,
  mkdtempSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { shouldAutoInstallGitHooks } from "./task-context.mjs";

const isWin = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PWSH_DIR = resolve(__dirname, ".cache", "bosun", "pwsh");
const BUNDLED_PWSH_PATH = resolve(BUNDLED_PWSH_DIR, "pwsh");
const FALLBACK_PWSH_VERSION = "7.4.6";

// ── Helpers ──────────────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`${isWin ? "where" : "which"} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd, flag = "--version") {
  try {
    return execSync(`${cmd} ${flag}`, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function bundledPwshExists() {
  return existsSync(BUNDLED_PWSH_PATH);
}

function isPwshSupportedPlatform(platform) {
  return platform === "linux" || platform === "darwin";
}

function getPwshAssetSuffix(platform, arch) {
  if (platform === "linux") {
    if (arch === "x64") return "linux-x64";
    if (arch === "arm64") return "linux-arm64";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "osx-x64";
    if (arch === "arm64") return "osx-arm64";
    return null;
  }
  return null;
}

function httpsGetJson(url) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "bosun-postinstall",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "bosun-postinstall" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        pipeline(res, createWriteStream(destPath))
          .then(resolvePromise)
          .catch(reject);
      },
    );
    req.on("error", reject);
  });
}

async function resolvePwshVersion() {
  const forced = String(process.env.BOSUN_PWSH_VERSION || "").trim();
  if (forced) return forced.replace(/^v/, "");
  try {
    const release = await httpsGetJson(
      "https://api.github.com/repos/PowerShell/PowerShell/releases/latest",
    );
    const tag = String(release?.tag_name || "").trim();
    if (tag) return tag.replace(/^v/, "");
  } catch {
    /* fallback */
  }
  return FALLBACK_PWSH_VERSION;
}

async function installBundledPwsh(platform, arch) {
  const suffix = getPwshAssetSuffix(platform, arch);
  if (!suffix) {
    throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
  }

  const version = await resolvePwshVersion();
  const assetName = `powershell-${version}-${suffix}.tar.gz`;
  const url = `https://github.com/PowerShell/PowerShell/releases/download/v${version}/${assetName}`;
  const tempDir = mkdtempSync(resolve(tmpdir(), "bosun-pwsh-"));
  const archivePath = resolve(tempDir, assetName);

  await downloadFile(url, archivePath);

  rmSync(BUNDLED_PWSH_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLED_PWSH_DIR, { recursive: true });

  execSync(`tar -xzf "${archivePath}" -C "${BUNDLED_PWSH_DIR}"`, {
    stdio: "ignore",
  });

  if (!existsSync(BUNDLED_PWSH_PATH)) {
    throw new Error("pwsh binary not found after extraction");
  }
  try {
    chmodSync(BUNDLED_PWSH_PATH, 0o755);
  } catch {
    /* best effort */
  }
  return { version, path: BUNDLED_PWSH_PATH };
}

// ── Dependency checks ────────────────────────────────────────────────────────

const REQUIRED = [
  {
    name: "git",
    cmd: "git",
    required: true,
    install: {
      win32: "winget install --id Git.Git -e --source winget",
      darwin: "brew install git",
      linux: "sudo apt install git  # or: sudo dnf install git",
    },
    url: "https://git-scm.com/downloads",
  },
];

const RECOMMENDED = [
  {
    name: "GitHub CLI (gh)",
    cmd: "gh",
    required: false,
    install: {
      win32: "winget install --id GitHub.cli -e --source winget",
      darwin: "brew install gh",
      linux:
        "sudo apt install gh  # or: https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
    },
    url: "https://cli.github.com/",
    why: "Required for PR creation, branch management, and GitHub operations",
  },
  {
    name: "GitHub Copilot CLI (copilot)",
    cmd: "copilot",
    required: false,
    install: {
      win32: "npm install -g @github/copilot",
      darwin: "npm install -g @github/copilot",
      linux: "npm install -g @github/copilot",
    },
    url: "https://github.com/github/copilot-cli",
    why: "Required for Copilot SDK primary agent sessions",
  },
  {
    name: "PowerShell (pwsh)",
    cmd: "pwsh",
    required: false,
    install: {
      win32: "winget install --id Microsoft.PowerShell -e --source winget",
      darwin: "brew install powershell/tap/powershell",
      linux:
        "sudo apt install powershell  # or: https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux",
    },
    url: "https://github.com/PowerShell/PowerShell",
    why: isWin
      ? "Required on Windows for PowerShell orchestrator scripts"
      : "Optional on macOS/Linux (only needed when using .ps1 orchestrator scripts)",
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Skip in CI environments
  if (process.env.CI || process.env.BOSUN_SKIP_POSTINSTALL) {
    return;
  }

  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │      bosun — environment check       │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");

  const platform = process.platform;
  let hasErrors = false;
  let hasWarnings = false;

  // Node.js version check
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) {
    console.log(`  :check: Node.js ${process.versions.node}`);
  } else {
    console.log(`  :close: Node.js ${process.versions.node} — requires ≥ 18`);
    hasErrors = true;
  }

  // Required tools
  for (const dep of REQUIRED) {
    if (commandExists(dep.cmd)) {
      const ver = getVersion(dep.cmd);
      console.log(`  :check: ${dep.name}${ver ? ` (${ver})` : ""}`);
    } else {
      console.log(`  :close: ${dep.name} — REQUIRED`);
      const hint = dep.install[platform] || dep.install.linux;
      console.log(`     Install: ${hint}`);
      console.log(`     Docs:    ${dep.url}`);
      hasErrors = true;
    }
  }

  // Optional: auto-install PowerShell on Linux/macOS if missing
  const autoInstallPwsh = parseBoolEnv(
    process.env.BOSUN_AUTO_INSTALL_PWSH,
    true,
  );
  if (
    autoInstallPwsh &&
    !commandExists("pwsh") &&
    !bundledPwshExists() &&
    isPwshSupportedPlatform(platform)
  ) {
    console.log("  ▸ Installing PowerShell (bundled)...");
    try {
      const info = await installBundledPwsh(platform, process.arch);
      console.log(`  :check: PowerShell bundled (${info.version})`);
    } catch (err) {
      console.log(`  :alert:  PowerShell bundle install failed: ${err.message}`);
    }
  }

  // Recommended tools
  for (const dep of RECOMMENDED) {
    const isPwsh = dep.cmd === "pwsh";
    const hasPwsh = isPwsh
      ? commandExists(dep.cmd) || bundledPwshExists()
      : commandExists(dep.cmd);
    if (hasPwsh) {
      const ver = getVersion(dep.cmd);
      if (isPwsh && bundledPwshExists() && !ver) {
        console.log(`  :check: ${dep.name} (bundled)`);
      } else {
        console.log(`  :check: ${dep.name}${ver ? ` (${ver})` : ""}`);
      }
    } else {
      console.log(`  :alert:  ${dep.name} — not found`);
      console.log(`     ${dep.why}`);
      const hint = dep.install[platform] || dep.install.linux;
      console.log(`     Install: ${hint}`);
      hasWarnings = true;
    }
  }

  // npm-installed tools (bundled with this package)
  console.log(`  :check: vibe-kanban (bundled)`);
  console.log(`  :check: @openai/codex-sdk (bundled)`);
  console.log(`  :check: @github/copilot-sdk (bundled)`);
  console.log(`  :check: @anthropic-ai/claude-agent-sdk (bundled)`);
  console.log(`  :check: @github/copilot-sdk (bundled)`);
  console.log(`  :check: @anthropic-ai/claude-agent-sdk (bundled)`);

  // Desktop dependencies (Electron) — optional but recommended for instant launch
  const desktopDir = resolve(__dirname, "desktop");
  const isDesktopInstallEnabled = parseBoolEnv(
    process.env.BOSUN_DESKTOP_INSTALL,
    true,
  );
  if (isDesktopInstallEnabled && existsSync(desktopDir)) {
    const binName = isWin ? "electron-builder.cmd" : "electron-builder";
    const binPath = resolve(desktopDir, "node_modules", ".bin", binName);
    if (!existsSync(binPath)) {
      console.log("");
      console.log("  ▸ Installing desktop dependencies (Electron)...");
      try {
        execSync("npm install", {
          cwd: desktopDir,
          stdio: "inherit",
          timeout: 0,
        });
        console.log("  :check: Desktop dependencies installed");
      } catch (err) {
        console.log(
          "  :alert:  Desktop dependency install failed — run manually:",
        );
        console.log("     npm -C scripts/bosun/desktop install");
      }
    }
  }

  // Summary
  console.log("");
  if (hasErrors) {
    console.log(
      "  :ban: Missing required dependencies. Install them before running bosun.",
    );
  } else if (hasWarnings) {
    console.log(
      "  \u2705 Core dependencies satisfied. Optional tools above unlock full functionality.",
    );
  } else {
    console.log("  \u2705 All dependencies satisfied!");
  }

  console.log("");
  console.log("  Get started:");
  console.log("    bosun --setup     Interactive setup wizard");
  console.log("    bosun             Start with existing config");
  console.log("    bosun --help       See all options");
  console.log("");

  // Auto-install git hooks when inside the repo and hooks are present.
  try {
    const skipHooks = parseBoolEnv(process.env.BOSUN_SKIP_GIT_HOOKS, false);
    if (!skipHooks && shouldAutoInstallGitHooks()) {
      const cwd = process.cwd();
      const hooksDir = resolve(cwd, ".githooks");
      if (existsSync(resolve(cwd, ".git")) && existsSync(hooksDir)) {
        execSync("git config core.hooksPath .githooks", { stdio: "ignore" });
      }
    }
  } catch {
    // Non-blocking; hooks can be installed via `npm run hooks:install`
  }

  // Sync vendor files into ui/vendor/ so the UI works fully offline.
  // Non-blocking — a missing vendor file just falls back to node_modules or CDN.
  try {
    const { syncVendorFiles } = await import("./vendor-sync.mjs");
    const { ok, results } = await syncVendorFiles({ silent: true });
    const synced = results.filter((r) => r.source).length;
    if (ok) {
      console.log(`  :check: Vendor files bundled into ui/vendor/ (${synced}/${results.length} files)`);
    } else {
      const missing = results.filter((r) => !r.source).map((r) => r.name);
      console.warn(`  :alert:  Some vendor files could not be bundled: ${missing.join(", ")}`);
      console.warn("     The UI server will fall back to CDN for those files.");
    }
  } catch (err) {
    console.warn(`  :alert:  vendor-sync skipped: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`  :alert:  postinstall failed: ${err.message}`);
});
