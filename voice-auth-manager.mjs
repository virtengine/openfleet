import { createHash, randomBytes } from "node:crypto";
import { exec as childExec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const VOICE_AUTH_STATE_PATH = join(homedir(), ".bosun", "voice-auth-state.json");
const STATE_TTL_MS = 15_000;

let _cachedState = null;
let _cachedStateAt = 0;

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

function readStateFile() {
  if (!existsSync(VOICE_AUTH_STATE_PATH)) return {};
  const raw = readFileSync(VOICE_AUTH_STATE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

function getCachedState(forceReload = false) {
  const isFresh = !forceReload && _cachedState && Date.now() - _cachedStateAt < STATE_TTL_MS;
  if (isFresh) return _cachedState;

  try {
    _cachedState = readStateFile();
  } catch {
    _cachedState = {};
  }
  _cachedStateAt = Date.now();
  return _cachedState;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const ts = Number(new Date(expiresAt).getTime());
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now() + 30_000;
}

function getProviderEnvCandidates(provider) {
  switch (provider) {
    case "openai":
      return [
        process.env.BOSUN_VOICE_OPENAI_ACCESS_TOKEN,
        process.env.OPENAI_OAUTH_ACCESS_TOKEN,
        process.env.OPENAI_ACCESS_TOKEN,
      ];
    case "azure":
      return [
        process.env.BOSUN_VOICE_AZURE_ACCESS_TOKEN,
        process.env.AZURE_OPENAI_ACCESS_TOKEN,
      ];
    case "claude":
      return [
        process.env.BOSUN_VOICE_CLAUDE_ACCESS_TOKEN,
        process.env.ANTHROPIC_ACCESS_TOKEN,
      ];
    case "gemini":
      return [
        process.env.BOSUN_VOICE_GEMINI_ACCESS_TOKEN,
        process.env.GEMINI_ACCESS_TOKEN,
        process.env.GOOGLE_ACCESS_TOKEN,
      ];
    default:
      return [];
  }
}

function getStateTokenCandidates(provider, state) {
  const byProvider = state?.providers?.[provider] || state?.[provider] || {};
  return [
    {
      token: byProvider?.accessToken,
      expiresAt: byProvider?.expiresAt,
      source: "state",
    },
    {
      token: byProvider?.access_token,
      expiresAt: byProvider?.expires_at,
      source: "state",
    },
  ];
}

export function resolveVoiceOAuthToken(provider, forceReload = false) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return null;

  const envToken = getProviderEnvCandidates(normalizedProvider)
    .map((token) => String(token || "").trim())
    .find(Boolean);
  if (envToken) {
    return {
      token: envToken,
      source: "env",
      provider: normalizedProvider,
    };
  }

  const state = getCachedState(forceReload);
  const candidates = getStateTokenCandidates(normalizedProvider, state);
  for (const candidate of candidates) {
    const token = String(candidate?.token || "").trim();
    if (!token) continue;
    if (isExpired(candidate?.expiresAt)) continue;
    return {
      token,
      source: candidate.source,
      provider: normalizedProvider,
      expiresAt: candidate?.expiresAt || null,
    };
  }

  return null;
}

export function hasVoiceOAuthToken(provider, forceReload = false) {
  return Boolean(resolveVoiceOAuthToken(provider, forceReload));
}

export function saveVoiceOAuthToken(provider, payload = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    throw new Error("provider is required");
  }

  const token = String(payload?.accessToken || payload?.access_token || "").trim();
  if (!token) {
    throw new Error("access token is required");
  }

  const current = getCachedState(true);
  const next = {
    ...current,
    providers: {
      ...(current?.providers || {}),
      [normalizedProvider]: {
        accessToken: token,
        expiresAt: payload?.expiresAt || payload?.expires_at || null,
        refreshToken: payload?.refreshToken || payload?.refresh_token || null,
        tokenType: payload?.tokenType || payload?.token_type || "Bearer",
        updatedAt: new Date().toISOString(),
      },
    },
  };

  mkdirSync(dirname(VOICE_AUTH_STATE_PATH), { recursive: true });
  writeFileSync(VOICE_AUTH_STATE_PATH, JSON.stringify(next, null, 2));
  _cachedState = next;
  _cachedStateAt = Date.now();

  return {
    ok: true,
    path: VOICE_AUTH_STATE_PATH,
    provider: normalizedProvider,
  };
}

export function getVoiceAuthStatePath() {
  return VOICE_AUTH_STATE_PATH;
}

// ── OpenAI Codex OAuth PKCE flow ──────────────────────────────────────────────
// Reverse-engineered from: https://github.com/openai/codex and
// https://github.com/anomalyco/opencode/issues/3281 (OpenCode implementation).
//
// Public PKCE client — same one used by the official Codex CLI and the
// ChatGPT desktop app. No client secret is required.
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_OAUTH_SCOPES = "openid profile email offline_access";
const OPENAI_OAUTH_CALLBACK_PORT = 1455;

/** Module-level pending login state — kept at module scope per hard rules. */
let _pendingLogin = null; // { state, codeVerifier, server, status, result, startedAt }

// ── PKCE helpers ──────────────────────────────────────────────────────────────

/** Generate a cryptographically secure code_verifier (RFC 7636 §4.1). */
function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

/** Derive the S256 code_challenge from a verifier (RFC 7636 §4.2). */
function computeCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Random opaque state value — guards against CSRF. */
function generateState() {
  return randomBytes(16).toString("hex");
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCodeForToken(code, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const res = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Callback HTTP server ──────────────────────────────────────────────────────

/** Spin up a one-shot HTTP server on port 1455 to catch the OAuth redirect. */
function createCallbackServer(expectedState, codeVerifier) {
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${OPENAI_OAUTH_CALLBACK_PORT}`);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    if (url.pathname !== "/auth/callback") {
      res.writeHead(404).end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") || error || "Unknown error";

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px">
        <h2>Sign-in failed</h2><p>${errorDescription}</p><p>You can close this window.</p>
      </body></html>`);
      if (_pendingLogin) {
        _pendingLogin.status = "error";
        _pendingLogin.result = { error: errorDescription };
      }
      setTimeout(() => server.close(), 500);
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400).end("Invalid callback");
      if (_pendingLogin) {
        _pendingLogin.status = "error";
        _pendingLogin.result = { error: "state_mismatch" };
      }
      setTimeout(() => server.close(), 500);
      return;
    }

    // Exchange code for token (async — we must not throw synchronously)
    exchangeCodeForToken(code, codeVerifier)
      .then((tokenData) => {
        const expiresAt = tokenData.expires_in
          ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
          : null;
        saveVoiceOAuthToken("openai", {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt,
          tokenType: tokenData.token_type || "Bearer",
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
          <h2 style="color:#10a37f">✓ Signed in successfully</h2>
          <p>You can close this window and return to Bosun.</p>
        </body></html>`);
        if (_pendingLogin) {
          _pendingLogin.status = "complete";
          _pendingLogin.result = { ok: true };
        }
      })
      .catch((err) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px">
          <h2>Token exchange failed</h2><p>${err.message}</p><p>You can close this window.</p>
        </body></html>`);
        if (_pendingLogin) {
          _pendingLogin.status = "error";
          _pendingLogin.result = { error: err.message };
        }
      })
      .finally(() => {
        setTimeout(() => server.close(), 1000);
      });
  });

  server.on("error", (err) => {
    if (_pendingLogin && _pendingLogin.status === "pending") {
      _pendingLogin.status = "error";
      _pendingLogin.result = { error: err.message };
    }
  });

  server.listen(OPENAI_OAUTH_CALLBACK_PORT, "localhost");
  return server;
}

// ── Open browser cross-platform ───────────────────────────────────────────────

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  childExec(cmd, (err) => {
    if (err) {
      // Non-fatal: the URL was already returned to the caller so the user can
      // paste it manually.
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initiate the OpenAI Codex OAuth PKCE login flow.
 *
 * Starts a temporary local HTTP server on port 1455, generates PKCE
 * credentials, opens the browser, and returns the auth URL.  Call
 * `getOpenAILoginStatus()` to poll for completion.
 *
 * Returns `{ authUrl }`.
 */
export function startOpenAICodexLogin() {
  // Cancel any pre-existing pending login
  cancelOpenAILogin();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Extra params observed in Codex CLI / OpenCode
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });

  const authUrl = `${OPENAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`;

  const server = createCallbackServer(state, codeVerifier);

  _pendingLogin = {
    state,
    codeVerifier,
    server,
    status: "pending",
    result: null,
    startedAt: Date.now(),
  };

  // Open browser — non-fatal if it fails
  try {
    openBrowser(authUrl);
  } catch {
    // ignore
  }

  return { authUrl };
}

/**
 * Poll the status of an in-progress login.
 *
 * Returns `{ status: "idle" | "pending" | "complete" | "error", result }`.
 */
export function getOpenAILoginStatus() {
  const hasToken = Boolean(resolveVoiceOAuthToken("openai", false));
  if (!_pendingLogin) {
    return { status: hasToken ? "connected" : "idle", hasToken };
  }
  const { status, result } = _pendingLogin;
  const elapsed = Date.now() - _pendingLogin.startedAt;
  // Auto-clean up stale logins after 5 minutes
  if (elapsed > 5 * 60 * 1000 && status === "pending") {
    cancelOpenAILogin();
    return { status: "idle", hasToken };
  }
  return { status, result: result || null, hasToken };
}

/**
 * Cancel an in-progress login and close the callback server.
 */
export function cancelOpenAILogin() {
  if (_pendingLogin?.server) {
    try {
      _pendingLogin.server.close();
    } catch {
      // ignore
    }
  }
  _pendingLogin = null;
}

/**
 * Remove the stored OpenAI OAuth token.
 */
export function logoutOpenAI() {
  const curr = getCachedState(true);
  if (!curr?.providers?.openai) return { ok: true, wasLoggedIn: false };
  const next = {
    ...curr,
    providers: {
      ...(curr.providers || {}),
      openai: undefined,
    },
  };
  // Strip undefined keys
  if (next.providers.openai === undefined) delete next.providers.openai;
  mkdirSync(dirname(VOICE_AUTH_STATE_PATH), { recursive: true });
  writeFileSync(VOICE_AUTH_STATE_PATH, JSON.stringify(next, null, 2));
  _cachedState = next;
  _cachedStateAt = Date.now();
  return { ok: true, wasLoggedIn: true };
}

/**
 * Refresh an expired OpenAI OAuth token using the stored refresh_token.
 * Updates the state file and returns the new token data.
 */
export async function refreshOpenAICodexToken() {
  const state = getCachedState(true);
  const providerData = state?.providers?.openai || {};
  const refreshToken =
    providerData.refreshToken || providerData.refresh_token;
  if (!refreshToken) throw new Error("No refresh token stored for openai");

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  });

  const res = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const tokenData = await res.json();
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
    : null;

  saveVoiceOAuthToken("openai", {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || refreshToken,
    expiresAt,
    tokenType: tokenData.token_type || "Bearer",
  });

  return tokenData;
}
