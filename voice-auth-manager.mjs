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

// ── Generic OAuth PKCE provider registry ─────────────────────────────────────
//
// Provider configs reverse-engineered from official CLI tools:
// • openai  — https://github.com/openai/codex + opencode/issues/3281
// • claude  — github.com/XiaoConstantine/dspy-go/pkg/llms (Claude Code client)
// • gemini  — google-gemini/gemini-cli (Google Gemini CLI public client)
//
// All use OAuth 2.0 Authorization Code + PKCE (RFC 7636) with no client secret
// (public clients per RFC 8252 §8.4).
const CLAUDE_DEFAULT_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
].join(" ");

const OPENAI_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  // Needed for /v1/models capability checks + endpoint test.
  "api.model.read",
  // Needed for realtime voice runtime session creation and media flow.
  "api.realtime.write",
  // Needed for primary response generation and result retrieval/debug.
  "api.responses.read",
  "api.responses.write",
  // Needed for transcription / speech input-output flows.
  "api.audio.write",
].join(" ");

const OPENAI_OPTIONAL_FILE_SCOPES = [
  // Optional: enable only if you plan retrieval/context-file pipelines soon.
  "api.files.read",
  "api.files.write",
].join(" ");

function normalizeScopeList(scopes) {
  return Array.from(
    new Set(
      String(scopes || "")
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).join(" ");
}

const GEMINI_DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const OAUTH_PROVIDERS = {
  openai: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    redirectUri: "http://localhost:1455/auth/callback",
    port: 1455,
    // Keep stable defaults, while allowing future scope expansion without code edits:
    // - BOSUN_OPENAI_OAUTH_SCOPES: full replacement list
    // - BOSUN_OPENAI_OAUTH_EXTRA_SCOPES: appended scopes
    scopes: normalizeScopeList(
      process.env.BOSUN_OPENAI_OAUTH_SCOPES?.trim()
      || `${OPENAI_DEFAULT_SCOPES} ${
        process.env.BOSUN_OPENAI_OAUTH_ENABLE_FILE_SCOPES === "true"
          ? OPENAI_OPTIONAL_FILE_SCOPES
          : ""
      } ${process.env.BOSUN_OPENAI_OAUTH_EXTRA_SCOPES || ""}`,
    ),
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    },
    accentColor: "#10a37f",
  },
  claude: {
    // Claude Code official OAuth client + scopes (Anthropic CLI parity).
    clientId: process.env.BOSUN_CLAUDE_OAUTH_CLIENT_ID?.trim()
      || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: process.env.BOSUN_CLAUDE_OAUTH_AUTHORIZE_URL?.trim()
      || "https://platform.claude.com/oauth/authorize",
    tokenUrl: process.env.BOSUN_CLAUDE_OAUTH_TOKEN_URL?.trim()
      || "https://platform.claude.com/v1/oauth/token",
    redirectUri: "http://localhost:10001/auth/callback",
    port: 10001,
    // Claude requires explicit scopes. Keep env override for emergency rotation.
    scopes: process.env.BOSUN_CLAUDE_OAUTH_SCOPES?.trim() || CLAUDE_DEFAULT_SCOPES,
    extraParams: {},
    accentColor: "#d97706",
  },
  gemini: {
    // Gemini CLI OAuth client (google-gemini/gemini-cli-core parity).
    clientId: process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID?.trim(),
    clientSecret: process.env.BOSUN_GEMINI_OAUTH_CLIENT_SECRET?.trim(),
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    redirectUri: "http://localhost:10002/auth/callback",
    port: 10002,
    scopes: process.env.BOSUN_GEMINI_OAUTH_SCOPES?.trim() || GEMINI_DEFAULT_SCOPES,
    extraParams: {
      // Offline access (refresh token) + force consent screen to re-issue refresh_token
      access_type: "offline",
      prompt: "consent",
    },
    accentColor: "#1a73e8",
  },
};

// Module-scope per-provider pending login state (never inside a function — hard rule).
const _providerPendingLogin = new Map();

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function _generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function _computeCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function _generateState() {
  return randomBytes(16).toString("hex");
}

// ── Generic token exchange ────────────────────────────────────────────────────

async function _exchangeCode(code, codeVerifier, cfg) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  const res = await fetch(cfg.tokenUrl, {
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

// ── Generic one-shot callback server ─────────────────────────────────────────

function _createCallbackServer(provider, cfg, expectedState, codeVerifier) {
  const port = cfg.port;
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${port}`);
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
    const pending = _providerPendingLogin.get(provider);

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px">
        <h2>Sign-in failed</h2><p>${errorDescription}</p><p>You can close this window.</p>
      </body></html>`);
      if (pending) { pending.status = "error"; pending.result = { error: errorDescription }; }
      setTimeout(() => server.close(), 500);
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400).end("Invalid callback");
      if (pending) { pending.status = "error"; pending.result = { error: "state_mismatch" }; }
      setTimeout(() => server.close(), 500);
      return;
    }

    _exchangeCode(code, codeVerifier, cfg)
      .then((tokenData) => {
        const expiresAt = tokenData.expires_in
          ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
          : null;
        saveVoiceOAuthToken(provider, {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt,
          tokenType: tokenData.token_type || "Bearer",
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
          <h2 style="color:${cfg.accentColor}">✓ Signed in successfully</h2>
          <p>You can close this window and return to Bosun.</p>
        </body></html>`);
        const p = _providerPendingLogin.get(provider);
        if (p) { p.status = "complete"; p.result = { ok: true }; }
      })
      .catch((err) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px">
          <h2>Token exchange failed</h2><p>${err.message}</p><p>You can close this window.</p>
        </body></html>`);
        const p = _providerPendingLogin.get(provider);
        if (p) { p.status = "error"; p.result = { error: err.message }; }
      })
      .finally(() => { setTimeout(() => server.close(), 1000); });
  });

  server.on("error", (err) => {
    const p = _providerPendingLogin.get(provider);
    if (p?.status === "pending") { p.status = "error"; p.result = { error: err.message }; }
  });

  server.listen(port, "localhost");
  return server;
}

// ── Open browser cross-platform ───────────────────────────────────────────────

function _openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  childExec(cmd, () => { /* non-fatal: URL already returned to caller */ });
}

// ── Generic provider login functions ────────────────────────────────────────

function _startProviderLogin(provider, options = {}) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);

  // Cancel any existing login for this provider
  _cancelProviderLogin(provider);

  const codeVerifier = _generateCodeVerifier();
  const codeChallenge = _computeCodeChallenge(codeVerifier);
  const state = _generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    ...(cfg.scopes ? { scope: cfg.scopes } : {}),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...cfg.extraParams,
  });

  const authUrl = `${cfg.authorizeUrl}?${params.toString()}`;
  const server = _createCallbackServer(provider, cfg, state, codeVerifier);

  _providerPendingLogin.set(provider, {
    state,
    codeVerifier,
    server,
    status: "pending",
    result: null,
    startedAt: Date.now(),
  });

  if (options.openBrowser !== false) {
    try { _openBrowser(authUrl); } catch { /* ignore */ }
  }

  return { authUrl };
}

function _getProviderLoginStatus(provider) {
  const resolved = resolveVoiceOAuthToken(provider, false);
  const hasToken = Boolean(resolved);
  const accessToken = resolved?.token || null;
  const pending = _providerPendingLogin.get(provider);
  if (!pending) {
    return { status: hasToken ? "connected" : "idle", hasToken, accessToken };
  }
  const elapsed = Date.now() - pending.startedAt;
  if (elapsed > 5 * 60 * 1000 && pending.status === "pending") {
    _cancelProviderLogin(provider);
    return { status: "idle", hasToken, accessToken };
  }
  return { status: pending.status, result: pending.result || null, hasToken, accessToken };
}

function _cancelProviderLogin(provider) {
  const pending = _providerPendingLogin.get(provider);
  if (pending?.server) {
    try { pending.server.close(); } catch { /* ignore */ }
  }
  _providerPendingLogin.delete(provider);
}

function _logoutProvider(provider) {
  const curr = getCachedState(true);
  if (!curr?.providers?.[provider]) return { ok: true, wasLoggedIn: false };
  const next = {
    ...curr,
    providers: { ...(curr.providers || {}) },
  };
  delete next.providers[provider];
  mkdirSync(dirname(VOICE_AUTH_STATE_PATH), { recursive: true });
  writeFileSync(VOICE_AUTH_STATE_PATH, JSON.stringify(next, null, 2));
  _cachedState = next;
  _cachedStateAt = Date.now();
  return { ok: true, wasLoggedIn: true };
}

async function _refreshProviderToken(provider) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);

  const state = getCachedState(true);
  const providerData = state?.providers?.[provider] || {};
  const refreshToken = providerData.refreshToken || providerData.refresh_token;
  if (!refreshToken) throw new Error(`No refresh token stored for ${provider}`);

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    ...(cfg.extraParams?.access_type ? { access_type: cfg.extraParams.access_type } : {}),
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);

  const res = await fetch(cfg.tokenUrl, {
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

  saveVoiceOAuthToken(provider, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || refreshToken,
    expiresAt,
    tokenType: tokenData.token_type || "Bearer",
  });

  return tokenData;
}

// ── Public API — OpenAI ──────────────────────────────────────────────────────

/** Start the OpenAI Codex OAuth PKCE flow (same as Codex CLI / ChatGPT app). */
export function startOpenAICodexLogin(options)    { return _startProviderLogin("openai", options); }
/** Poll the status of an in-progress OpenAI login. */
export function getOpenAILoginStatus()     { return _getProviderLoginStatus("openai"); }
/** Cancel an in-progress OpenAI login. */
export function cancelOpenAILogin()        { return _cancelProviderLogin("openai"); }
/** Remove the stored OpenAI OAuth token. */
export function logoutOpenAI()             { return _logoutProvider("openai"); }
/** Refresh an expired OpenAI access token using the stored refresh_token. */
export async function refreshOpenAICodexToken() { return _refreshProviderToken("openai"); }

// ── Public API — Claude ──────────────────────────────────────────────────────

/** Start the Anthropic Claude OAuth PKCE flow (same as `claude auth login`). */
export function startClaudeLogin(options)         { return _startProviderLogin("claude", options); }
/** Poll the status of an in-progress Claude login. */
export function getClaudeLoginStatus()     { return _getProviderLoginStatus("claude"); }
/** Cancel an in-progress Claude login. */
export function cancelClaudeLogin()        { return _cancelProviderLogin("claude"); }
/** Remove the stored Claude OAuth token. */
export function logoutClaude()             { return _logoutProvider("claude"); }
/** Refresh an expired Claude access token. */
export async function refreshClaudeToken() { return _refreshProviderToken("claude"); }

// ── Public API — Google Gemini ───────────────────────────────────────────────

/** Start the Google Gemini OAuth PKCE flow (same as gemini-cli `gemini auth login`). */
export function startGeminiLogin(options)         { return _startProviderLogin("gemini", options); }
/** Poll the status of an in-progress Gemini login. */
export function getGeminiLoginStatus()     { return _getProviderLoginStatus("gemini"); }
/** Cancel an in-progress Gemini login. */
export function cancelGeminiLogin()        { return _cancelProviderLogin("gemini"); }
/** Remove the stored Gemini OAuth token. */
export function logoutGemini()             { return _logoutProvider("gemini"); }
/** Refresh an expired Gemini access token. */
export async function refreshGeminiToken() { return _refreshProviderToken("gemini"); }
