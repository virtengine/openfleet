#!/usr/bin/env node
/**
 * github-app-auth.mjs — GitHub App JWT + Installation Token helpers
 *
 * Provides credential helpers for the Bosun[botswain] GitHub App:
 *   - signAppJWT()                        — RS256 JWT proving Bosun IS the app
 *   - getInstallationToken(installationId) — short-lived install access token
 *   - getInstallationTokenForRepo(owner,repo) — auto-resolves install from repo
 *   - exchangeOAuthCode(code)             — user OAuth code → user access token
 *   - verifyAppWebhookSignature(body,sig) — HMAC-SHA256 check for app webhooks
 *
 * Env vars consumed:
 *   BOSUN_GITHUB_APP_ID          — numeric App ID (e.g. 2911413)
 *   BOSUN_GITHUB_PRIVATE_KEY_PATH — path to .pem downloaded from App settings
 *   BOSUN_GITHUB_CLIENT_ID       — OAuth Client ID
 *   BOSUN_GITHUB_CLIENT_SECRET   — OAuth Client Secret
 *   BOSUN_GITHUB_WEBHOOK_SECRET  — webhook HMAC secret (set in App settings)
 */

import { createSign, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Load the private key PEM once (cached). */
let _privateKeyPem = null;
function getPrivateKey() {
  if (_privateKeyPem) return _privateKeyPem;
  const path = process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH || "";
  if (!path) throw new Error("BOSUN_GITHUB_PRIVATE_KEY_PATH is not set");
  if (!existsSync(path)) throw new Error(`Private key not found: ${path}`);
  _privateKeyPem = readFileSync(path, "utf8");
  return _privateKeyPem;
}

/** Reset key cache (useful in tests / after key rotation). */
export function resetPrivateKeyCache() {
  _privateKeyPem = null;
}

// ── JWT ──────────────────────────────────────────────────────────────────────

/**
 * Signs and returns a GitHub App JWT valid for up to 10 minutes.
 * GitHub requires: iat = now-60s (clock skew), exp = now+600s, iss = App ID.
 */
export function signAppJWT() {
  const appId = String(process.env.BOSUN_GITHUB_APP_ID || "").trim();
  if (!appId) throw new Error("BOSUN_GITHUB_APP_ID is not set");

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  );

  const signing = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signing);
  const sig = b64url(signer.sign(getPrivateKey()));
  return `${signing}.${sig}`;
}

// ── Installation token ───────────────────────────────────────────────────────

/**
 * Exchanges a JWT for a short-lived installation access token.
 * Valid for 1 hour; scoped to the installation's repositories.
 *
 * @param {string|number} installationId
 * @returns {Promise<{token: string, expiresAt: string}>}
 */
export async function getInstallationToken(installationId) {
  const jwt = signAppJWT();
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bosun-botswain",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub installation token request failed ${res.status}: ${body}`,
    );
  }
  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * Lists all installations for this App, finds the one covering the given
 * owner/repo, and returns an installation access token for it.
 *
 * @param {string} owner — org or user login
 * @param {string} repo  — repo name (without owner prefix)
 * @returns {Promise<{token: string, expiresAt: string, installationId: number}>}
 */
export async function getInstallationTokenForRepo(owner, repo) {
  const jwt = signAppJWT();

  // Prefer direct repo-level installation lookup (faster, 1 API call).
  const repoRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bosun-botswain",
      },
    },
  );
  if (!repoRes.ok) {
    const body = await repoRes.text();
    throw new Error(
      `Could not find GitHub App installation for ${owner}/${repo} (${repoRes.status}): ${body}`,
    );
  }
  const installation = await repoRes.json();
  const result = await getInstallationToken(installation.id);
  return { ...result, installationId: installation.id };
}

// ── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Starts a GitHub Device Flow authorization request.
 * The user visits the returned URL, enters the code, and authorizes.
 * Then poll with pollDeviceToken() until authorization completes.
 *
 * Requires BOSUN_GITHUB_CLIENT_ID. No client secret or public URL needed.
 * NOTE: Device Flow must be enabled in the GitHub App settings.
 *
 * @param {string} [scope] — OAuth scopes (default: "repo")
 * @returns {Promise<{deviceCode: string, userCode: string, verificationUri: string, expiresIn: number, interval: number}>}
 */
export async function startDeviceFlow(scope = "repo") {
  const clientId = process.env.BOSUN_GITHUB_CLIENT_ID || "";
  if (!clientId) {
    throw new Error("BOSUN_GITHUB_CLIENT_ID must be set for Device Flow");
  }

  const body = new URLSearchParams({ client_id: clientId, scope });
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bosun-botswain",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device flow initiation failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Device flow error: ${data.error} — ${data.error_description || ""}`);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

/**
 * Polls GitHub to check if the user has completed device authorization.
 *
 * Returns one of:
 *   - { status: "complete", accessToken, tokenType, scope }
 *   - { status: "pending" }                        — user hasn't entered code yet
 *   - { status: "slow_down", interval }             — increase poll interval
 *   - { status: "expired" }                         — code expired, restart flow
 *   - { status: "error", error, description }       — permanent error
 *
 * @param {string} deviceCode — from startDeviceFlow()
 * @returns {Promise<{status: string, accessToken?: string, tokenType?: string, scope?: string, interval?: number, error?: string, description?: string}>}
 */
export async function pollDeviceToken(deviceCode) {
  const clientId = process.env.BOSUN_GITHUB_CLIENT_ID || "";
  if (!clientId) {
    throw new Error("BOSUN_GITHUB_CLIENT_ID must be set");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bosun-botswain",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device token poll failed ${res.status}: ${text}`);
  }

  const data = await res.json();

  if (data.access_token) {
    return {
      status: "complete",
      accessToken: data.access_token,
      tokenType: data.token_type,
      scope: data.scope || "",
    };
  }

  switch (data.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", interval: data.interval };
    case "expired_token":
      return { status: "expired" };
    default:
      return {
        status: "error",
        error: data.error,
        description: data.error_description || "",
      };
  }
}

/**
 * Exchanges an OAuth authorization code for a user access token.
 * Called from the /api/github/callback route after GitHub redirects the user.
 *
 * @param {string} code — the `code` query param from GitHub's redirect
 * @returns {Promise<{accessToken: string, tokenType: string, scope: string}>}
 */
export async function exchangeOAuthCode(code) {
  const clientId = process.env.BOSUN_GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.BOSUN_GITHUB_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "BOSUN_GITHUB_CLIENT_ID and BOSUN_GITHUB_CLIENT_SECRET must be set",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bosun-botswain",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(
      `OAuth error: ${data.error} — ${data.error_description || ""}`,
    );
  }

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope || "",
  };
}

/**
 * Fetches the authenticated GitHub user for a given OAuth access token.
 * Useful to identify which user installed/authorized the app.
 *
 * @param {string} accessToken
 * @returns {Promise<{login: string, id: number, name: string|null, email: string|null}>}
 */
export async function getOAuthUser(accessToken) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bosun-botswain",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub /user request failed ${res.status}: ${text}`);
  }
  const u = await res.json();
  return { login: u.login, id: u.id, name: u.name ?? null, email: u.email ?? null };
}

// ── Webhook signature ────────────────────────────────────────────────────────

/**
 * Verifies the HMAC-SHA256 signature GitHub sends with App webhook deliveries.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param {Buffer|string} rawBody  — raw request body bytes
 * @param {string}        sigHeader — value of X-Hub-Signature-256 header
 * @returns {boolean}
 */
export function verifyAppWebhookSignature(rawBody, sigHeader) {
  const secret = process.env.BOSUN_GITHUB_WEBHOOK_SECRET || "";
  if (!secret) return false; // no secret configured → reject all
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;

  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  const provided = Buffer.from(sigHeader);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ── App info ─────────────────────────────────────────────────────────────────

/**
 * Returns whether the GitHub App is configured (App ID + private key present).
 */
export function isAppConfigured() {
  const appId = String(process.env.BOSUN_GITHUB_APP_ID || "").trim();
  const keyPath = String(process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH || "").trim();
  return Boolean(appId && keyPath && existsSync(keyPath));
}

/**
 * Returns whether the OAuth flow is configured (client ID + secret present).
 */
export function isOAuthConfigured() {
  return Boolean(
    process.env.BOSUN_GITHUB_CLIENT_ID &&
      process.env.BOSUN_GITHUB_CLIENT_SECRET,
  );
}

/**
 * Returns the App ID as a string, or null if not configured.
 */
export function getAppId() {
  const v = String(process.env.BOSUN_GITHUB_APP_ID || "").trim();
  return v || null;
}
