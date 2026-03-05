/**
 * github-auth-manager.mjs — Unified GitHub authentication for Bosun
 *
 * Auth priority:
 *   1. OAuth user token (from ~/.bosun/github-auth-state.json or BOSUN_GITHUB_USER_TOKEN)
 *   2. GitHub App installation token (when App is configured + repo is known)
 *   3. gh CLI token (from `gh auth token`)
 *   4. GITHUB_TOKEN / GH_TOKEN env vars
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isAppConfigured,
  getInstallationTokenForRepo,
} from "./github-app-auth.mjs";

// ── Constants ─────────────────────────────────────────────────────────────────

const BOSUN_AUTH_STATE_PATH = join(homedir(), ".bosun", "github-auth-state.json");

// ── OAuth state loader ────────────────────────────────────────────────────────

/**
 * Load saved OAuth user token from ~/.bosun/github-auth-state.json.
 * Returns null if no file or no valid token.
 */
async function loadSavedOAuthToken() {
  // First check env override
  const envToken = process.env.BOSUN_GITHUB_USER_TOKEN;
  if (envToken) return envToken;

  try {
    const raw = await readFile(BOSUN_AUTH_STATE_PATH, "utf8");
    const data = JSON.parse(raw);
    const token = data?.accessToken || data?.access_token || null;
    if (!token) return null;

    // If there's an expiry, check it
    if (data.expiresAt || data.expires_at) {
      const expiry = new Date(data.expiresAt || data.expires_at);
      if (!isNaN(expiry.getTime()) && expiry < new Date()) {
        // Token expired
        return null;
      }
    }

    return token;
  } catch {
    return null;
  }
}

// ── gh CLI fallback ───────────────────────────────────────────────────────────

/**
 * Attempt to retrieve the token via `gh auth token`.
 * Returns null if gh is not installed or not authenticated.
 */
async function getGhCliToken() {
  try {
    const { execFileSync } = await import("node:child_process");
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

// ── Verify a token is valid via /user ─────────────────────────────────────────

async function verifyToken(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bosun-ve",
      },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u?.login || null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the best available token for GitHub API calls.
 *
 * @param {Object} [options]
 * @param {string} [options.owner] - repo owner (for installation token resolution)
 * @param {string} [options.repo]  - repo name (for installation token resolution)
 * @param {boolean} [options.verify] - verify token via /user API (default: false for perf)
 * @returns {Promise<{token: string, type: 'oauth'|'installation'|'gh-cli'|'env', login?: string}>}
 */
export async function getGitHubToken(options = {}) {
  const { owner, repo, verify = false } = options;

  // ── 1. OAuth user token ───────────────────────────────────────────────────
  const oauthToken = await loadSavedOAuthToken();
  if (oauthToken) {
    const login = verify ? await verifyToken(oauthToken) : undefined;
    if (!verify || login) {
      return { token: oauthToken, type: "oauth", login: login ?? undefined };
    }
  }

  // ── 2. GitHub App installation token ─────────────────────────────────────
  if (owner && repo && isAppConfigured()) {
    try {
      const { token } = await getInstallationTokenForRepo(owner, repo);
      if (token) {
        return { token, type: "installation" };
      }
    } catch {
      // App installation not found — continue to next fallback
    }
  }

  // ── 3. gh CLI token ───────────────────────────────────────────────────────
  const ghCliToken = await getGhCliToken();
  if (ghCliToken) {
    return { token: ghCliToken, type: "gh-cli" };
  }

  // ── 4. Environment variable fallback ─────────────────────────────────────
  const envToken =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_PAT ||
    "";
  if (envToken) {
    return { token: envToken, type: "env" };
  }

  throw new Error(
    "No GitHub auth available. Set GITHUB_TOKEN, run `gh auth login`, " +
      "or configure the Bosun GitHub App (BOSUN_GITHUB_APP_ID + BOSUN_GITHUB_PRIVATE_KEY_PATH).",
  );
}

/**
 * Returns Authorization headers for GitHub API calls using the best available token.
 *
 * @param {Object} [options] - same as getGitHubToken options
 * @returns {Promise<{'Authorization': string, 'User-Agent': string, 'Accept': string, 'X-GitHub-Api-Version': string}>}
 */
export async function getAuthHeaders(options = {}) {
  const { token } = await getGitHubToken(options);
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bosun-ve",
  };
}

/**
 * Returns a GitHub token suitable for use with `git push` operations.
 * Used by git credential helpers or setting up remote URLs.
 *
 * @param {string} [owner] - repo owner (for installation token resolution)
 * @param {string} [repo]  - repo name (for installation token resolution)
 * @returns {Promise<string>} token string
 */
export async function getGitToken(owner, repo) {
  const { token } = await getGitHubToken({ owner, repo });
  return token;
}

/**
 * Check if any GitHub auth is available (any method works).
 *
 * @returns {Promise<boolean>}
 */
export async function hasAnyAuth() {
  try {
    await getGitHubToken();
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a human-readable summary of auth status for display.
 *
 * @returns {Promise<{available: boolean, type?: string, login?: string, message: string}>}
 */
export async function getAuthStatus() {
  // Check OAuth user token
  const oauthToken = await loadSavedOAuthToken();
  if (oauthToken) {
    const login = await verifyToken(oauthToken);
    if (login) {
      return {
        available: true,
        type: "oauth",
        login,
        message: `GitHub OAuth user token — authenticated as @${login}`,
      };
    }
    return {
      available: false,
      type: "oauth",
      message: "GitHub OAuth user token found but invalid/expired",
    };
  }

  // Check App
  const appConfigured = isAppConfigured();

  // Check gh CLI
  const ghCliToken = await getGhCliToken();
  if (ghCliToken) {
    const login = await verifyToken(ghCliToken);
    return {
      available: true,
      type: "gh-cli",
      login: login ?? undefined,
      message: login
        ? `gh CLI token — authenticated as @${login}`
        : "gh CLI token — valid but could not resolve login",
    };
  }

  // Check env vars
  const envToken =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_PAT ||
    "";
  if (envToken) {
    const login = await verifyToken(envToken);
    return {
      available: true,
      type: "env",
      login: login ?? undefined,
      message: login
        ? `Environment token — authenticated as @${login}`
        : "Environment token set (GITHUB_TOKEN/GH_TOKEN) — could not verify",
    };
  }

  const hints = [];
  if (appConfigured) hints.push("GitHub App is configured (installation tokens available for known repos)");
  hints.push("Run `gh auth login` to authenticate via the gh CLI");
  hints.push("Or set GITHUB_TOKEN / GH_TOKEN environment variable");

  return {
    available: false,
    message: `No GitHub authentication available. ${hints.join(". ")}`,
  };
}
