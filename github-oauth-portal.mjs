/**
 * github-oauth-portal.mjs — Self-contained OAuth setup portal for Bosun[VE]
 *
 * Serves a local HTTP portal on port 54317 (bound to 127.0.0.1) that guides
 * users through GitHub App installation and OAuth authorisation.
 *
 * Routes:
 *   GET  /                    — portal home / instructions page
 *   GET  /github/install      — redirect to GitHub App installation page
 *   GET  /github/callback     — OAuth authorisation callback (register in GitHub App)
 *   GET  /github/setup        — post-installation setup redirect (register in GitHub App)
 *   POST /webhook             — GitHub App webhook receiver
 *   GET  /api/status          — JSON status endpoint
 *   GET  /api/installations   — list App installations (requires App JWT)
 *
 * GitHub App settings (https://github.com/settings/apps/bosun-ve):
 *   Callback URL:  http://127.0.0.1:54317/github/callback  ← ONLY URL needed
 *
 * Notes:
 *   - Setup URL is UNAVAILABLE when "Request user authorization during installation"
 *     is enabled — GitHub redirects to the Callback URL instead (passing
 *     installation_id + setup_action=install). This route already handles it.
 *   - Device Flow checkbox is GREYED OUT until the Callback URL is saved.
 *     Order: set Callback URL → Save → then enable Device Flow.
 *
 * @module github-oauth-portal
 */

import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import {
  signAppJWT,
  exchangeOAuthCode,
  getOAuthUser,
  verifyAppWebhookSignature,
  isAppConfigured,
  isOAuthConfigured,
  getAppId,
  saveOAuthState,
  loadOAuthState,
} from "./github-app-auth.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 54317;
const DEFAULT_HOST = "127.0.0.1";
const GITHUB_APP_NAME = "bosun-ve";
const GITHUB_APP_URL = `https://github.com/apps/${GITHUB_APP_NAME}`;
const GITHUB_APP_INSTALL_URL = `${GITHUB_APP_URL}/installations/new`;
const STATE_FILE = join(homedir(), ".bosun", "github-auth-state.json");
const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── CSRF state store ─────────────────────────────────────────────────────────

/** @type {Map<string, number>} state token → expiry timestamp */
const csrfTokens = new Map();

function generateCsrfToken() {
  const token = randomBytes(16).toString("hex");
  csrfTokens.set(token, Date.now() + CSRF_TTL_MS);
  // Clean up expired tokens
  for (const [k, exp] of csrfTokens) {
    if (Date.now() > exp) csrfTokens.delete(k);
  }
  return token;
}

function consumeCsrfToken(token) {
  if (!token) return false;
  const exp = csrfTokens.get(token);
  if (!exp) return false;
  csrfTokens.delete(token);
  return Date.now() <= exp;
}

// ── Installation state ───────────────────────────────────────────────────────

/** @type {number[]} */
let _installationIds = [];

function loadInstallationIds() {
  try {
    const state = loadOAuthState();
    if (state && Array.isArray(state.installationIds)) {
      _installationIds = state.installationIds;
    }
  } catch {
    // ignore
  }
}

loadInstallationIds();

// ── Webhook EventEmitter ─────────────────────────────────────────────────────

/**
 * EventEmitter that broadcasts parsed GitHub webhook events.
 * Other modules (e.g. monitor.mjs) can subscribe like:
 *   webhookEvents.on('bosun:command:run', ({ taskId }) => ...)
 *
 * @type {EventEmitter}
 */
export const webhookEvents = new EventEmitter();

// ── HTML helpers ─────────────────────────────────────────────────────────────

function htmlPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Bosun</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --red: #f85149;
      --yellow: #d29922;
      --radius: 10px;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      padding: 24px;
      max-width: 860px;
      margin: 0 auto;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
    h2 { font-size: 18px; font-weight: 600; margin: 24px 0 12px; }
    h3 { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
    p { color: var(--muted); margin-bottom: 12px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .logo { font-size: 32px; margin-bottom: 4px; }
    .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 32px; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
      margin-bottom: 20px;
    }
    .card-title {
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 12px;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-green { background: var(--green); }
    .dot-red { background: var(--red); }
    .dot-yellow { background: var(--yellow); }
    .url-row {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 8px;
      font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
      font-size: 12px;
      color: var(--accent);
    }
    .url-row span { flex: 1; word-break: break-all; }
    .copy-btn {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--muted);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 8px;
      flex-shrink: 0;
      transition: border-color 0.15s, color 0.15s;
    }
    .copy-btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn {
      display: inline-block;
      padding: 10px 20px;
      border-radius: 7px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      border: none;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: var(--accent); color: #0d1117; }
    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
    .tag {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
    }
    .tag-green { background: rgba(63,185,80,.15); color: var(--green); }
    .tag-red { background: rgba(248,81,73,.15); color: var(--red); }
    .tag-yellow { background: rgba(210,153,34,.15); color: var(--yellow); }
    .user-card {
      display: flex; align-items: center; gap: 14px;
    }
    .user-avatar {
      width: 48px; height: 48px; border-radius: 50%;
      border: 2px solid var(--border);
    }
    .user-login { font-size: 16px; font-weight: 600; }
    .user-id { color: var(--muted); font-size: 12px; }
    ol, ul { padding-left: 20px; color: var(--muted); }
    ol li, ul li { margin-bottom: 6px; }
    code {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 5px;
      font-family: "SF Mono", monospace;
      font-size: 12px;
    }
    .alert {
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .alert-success { background: rgba(63,185,80,.1); border: 1px solid rgba(63,185,80,.3); color: var(--green); }
    .alert-error   { background: rgba(248,81,73,.1);  border: 1px solid rgba(248,81,73,.3);  color: var(--red); }
    .alert-info    { background: rgba(88,166,255,.1); border: 1px solid rgba(88,166,255,.3); color: var(--accent); }
    hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
  </style>
</head>
<body>
  <div class="logo">⚓</div>
  <h1>Bosun</h1>
  <div class="subtitle">GitHub App OAuth Setup Portal · <code>bosun-ve</code></div>
  ${bodyHtml}
  <script>
    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.color = 'var(--green)';
        btn.style.borderColor = 'var(--green)';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.color = '';
          btn.style.borderColor = '';
        }, 1500);
      });
    }
  </script>
</body>
</html>`;
}

function urlRow(url) {
  return `<div class="url-row">
    <span id="url-${Buffer.from(url).toString("hex").slice(0, 8)}">${url}</span>
    <button class="copy-btn" onclick="copyToClipboard('${url}', this)">Copy</button>
  </div>`;
}

// ── Request body reader ──────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleHome(req, res) {
  const state = loadOAuthState();
  const authenticated = Boolean(state?.accessToken);
  const appConfigured = isAppConfigured();
  const oauthConfigured = isOAuthConfigured();
  const appId = getAppId();

  const cbUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/github/callback`;
  const setupUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/github/setup`;

  const statusRows = `
    <div class="status-row">
      <div class="dot ${appConfigured ? "dot-green" : "dot-red"}"></div>
      <span>${appConfigured ? "App JWT configured (App ID + private key)" : "App ID / private key not configured"}</span>
      ${appId ? `<span class="tag tag-green">App ID: ${appId}</span>` : ""}
    </div>
    <div class="status-row">
      <div class="dot ${oauthConfigured ? "dot-green" : "dot-red"}"></div>
      <span>${oauthConfigured ? "OAuth credentials configured" : "OAuth Client ID / Secret missing"}</span>
    </div>
    <div class="status-row">
      <div class="dot ${authenticated ? "dot-green" : "dot-yellow"}"></div>
      <span>${authenticated ? `Authenticated as <strong>${state.user?.login ?? "unknown"}</strong>` : "Not yet authenticated via OAuth"}</span>
    </div>
  `;

  const urlsSection = `
    <div class="card">
      <div class="card-title">URL to register in GitHub App settings</div>
      <h3>Callback URL <span class="tag tag-green">required</span></h3>
      ${urlRow(cbUrl)}
      <div class="alert alert-info" style="margin-top:12px">
        <strong>Setup URL</strong> — leave blank. When <em>Request user authorization (OAuth) during installation</em> is enabled, GitHub redirects to the Callback URL instead, passing <code>installation_id</code> &amp; <code>setup_action=install</code>. This portal handles that automatically.<br><br>
        <strong>Device Flow greyed out?</strong> Paste the Callback URL above, click <strong>Save changes</strong>, then the Device Flow checkbox will become clickable.
      </div>
      <p style="margin-top:12px">Navigate to <a href="https://github.com/settings/apps/${GITHUB_APP_NAME}" target="_blank">GitHub App settings → ${GITHUB_APP_NAME}</a> and paste the Callback URL above.</p>
    </div>
  `;

  const userSection = authenticated
    ? `<div class="card">
        <div class="card-title">Authenticated User</div>
        <div class="user-card">
          <img class="user-avatar" src="https://github.com/${state.user?.login}.png?size=96" alt="${state.user?.login}" />
          <div>
            <div class="user-login">${state.user?.login}</div>
            <div class="user-id">GitHub ID: ${state.user?.id}</div>
            <div class="user-id">Saved: ${state.savedAt ? new Date(state.savedAt).toLocaleString() : "unknown"}</div>
          </div>
        </div>
      </div>`
    : "";

  const actionSection = oauthConfigured
    ? `<div class="btn-row">
        <a class="btn btn-primary" href="/github/install">Install / Authorize GitHub App</a>
        <a class="btn btn-secondary" href="/api/status">API Status</a>
      </div>`
    : `<div class="alert alert-info">
        Set <code>BOSUN_GITHUB_CLIENT_ID</code> and <code>BOSUN_GITHUB_CLIENT_SECRET</code> env vars to enable OAuth flow.
      </div>
      <div class="btn-row">
        <a class="btn btn-secondary" href="${GITHUB_APP_INSTALL_URL}" target="_blank">Install App (direct)</a>
        <a class="btn btn-secondary" href="/api/status">API Status</a>
      </div>`;

  const body = `
    <div class="card">
      <div class="card-title">Configuration Status</div>
      ${statusRows}
    </div>
    ${urlsSection}
    ${userSection}
    <div class="card">
      <div class="card-title">Quick Start</div>
      <ol>
        <li>In <a href="https://github.com/settings/apps/${GITHUB_APP_NAME}" target="_blank">GitHub App settings</a>:<ul style="margin-top:6px">
          <li>Set <strong>Callback URL</strong> to the value above and click <strong>Save changes</strong>.</li>
          <li>Enable <strong>Request user authorization (OAuth) during installation</strong> ✓</li>
          <li>Enable <strong>Device Flow</strong> ✓ (only available after Callback URL is saved)</li>
          <li>Leave <strong>Setup URL</strong> blank — it is disabled &amp; not needed.</li>
          <li>Leave <strong>Redirect on update</strong> unchecked (Setup URL is unavailable).</li>
        </ul></li>
        <li>Set env vars: <code>BOSUN_GITHUB_CLIENT_ID</code> (already in .env.example), optionally <code>BOSUN_GITHUB_CLIENT_SECRET</code> (not needed for Device Flow)</li>
        <li>Click <strong>Install / Authorize GitHub App</strong> below.</li>
        <li>After authorization, Bosun saves your token to <code>~/.bosun/github-auth-state.json</code>.</li>
      </ol>
      ${actionSection}
    </div>
  `;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(htmlPage("Setup Portal", body));
}

function handleInstall(req, res) {
  const state = generateCsrfToken();
  const clientId = process.env.BOSUN_GITHUB_CLIENT_ID || "";

  let redirectUrl;
  if (clientId) {
    // Use OAuth flow so we get a user token back too
    redirectUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${state}&redirect_uri=${encodeURIComponent(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/github/callback`)}`;
  } else {
    // Fallback: direct installation URL (no user token)
    redirectUrl = `${GITHUB_APP_INSTALL_URL}?state=${state}`;
  }

  res.writeHead(302, { Location: redirectUrl });
  res.end();
}

async function handleCallback(req, res) {
  const urlObj = new URL(req.url, `http://${DEFAULT_HOST}`);
  const code = urlObj.searchParams.get("code");
  const state = urlObj.searchParams.get("state");
  const installationId = urlObj.searchParams.get("installation_id");
  const setupAction = urlObj.searchParams.get("setup_action");

  // Validate CSRF — allow state to be absent if GitHub passes it only on install
  if (state && !consumeCsrfToken(state)) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Error",
        '<div class="alert alert-error">Invalid or expired CSRF state token. Please try again.</div><a class="btn btn-secondary" href="/">← Back</a>',
      ),
    );
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Error",
        '<div class="alert alert-error">Missing <code>code</code> parameter from GitHub.</div><a class="btn btn-secondary" href="/">← Back</a>',
      ),
    );
    return;
  }

  let user = null;
  let accessToken = null;
  let tokenType = "bearer";
  let scope = "";

  try {
    const result = await exchangeOAuthCode(code);
    accessToken = result.accessToken;
    tokenType = result.tokenType;
    scope = result.scope;
    user = await getOAuthUser(accessToken);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Auth Error",
        `<div class="alert alert-error">OAuth exchange failed: ${String(err.message).replace(/</g, "&lt;")}</div><a class="btn btn-secondary" href="/">← Back</a>`,
      ),
    );
    return;
  }

  // Persist state
  const authState = {
    user,
    accessToken,
    tokenType,
    scope,
    savedAt: new Date().toISOString(),
    installationIds: installationId
      ? [...new Set([..._installationIds, Number(installationId)])]
      : _installationIds,
  };
  try {
    saveOAuthState(authState);
    _installationIds = authState.installationIds;
  } catch (err) {
    // Non-fatal — continue
    console.error("[oauth-portal] Failed to save auth state:", err.message);
  }

  // Update .env if possible
  try {
    updateEnvFile("BOSUN_GITHUB_USER_TOKEN", accessToken);
  } catch {
    // Not critical
  }

  // Broadcast auth_complete
  webhookEvents.emit("auth_complete", { user });

  const loginHtml = user
    ? `<div class="user-card">
        <img class="user-avatar" src="https://github.com/${user.login}.png?size=96" alt="${user.login}" />
        <div>
          <div class="user-login">${user.login}</div>
          <div class="user-id">GitHub ID: ${user.id}</div>
        </div>
      </div>`
    : "<p>Token saved.</p>";

  const body = `
    <div class="alert alert-success">✓ Authorization successful!</div>
    <div class="card">
      <div class="card-title">Authenticated User</div>
      ${loginHtml}
    </div>
    ${installationId ? `<div class="card"><div class="card-title">Installation</div><p>Installation ID: <strong>${installationId}</strong> (${setupAction ?? "install"})</p></div>` : ""}
    <div class="btn-row">
      <a class="btn btn-primary" href="/">← Back to portal</a>
    </div>
  `;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(htmlPage("Authorization Complete", body));
}

async function handleSetup(req, res) {
  const urlObj = new URL(req.url, `http://${DEFAULT_HOST}`);
  const installationId = urlObj.searchParams.get("installation_id");
  const setupAction = urlObj.searchParams.get("setup_action") ?? "install";

  if (!installationId) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Error",
        '<div class="alert alert-error">Missing <code>installation_id</code> parameter.</div><a class="btn btn-secondary" href="/">← Back</a>',
      ),
    );
    return;
  }

  // Update saved installation IDs
  const newIds = [...new Set([..._installationIds, Number(installationId)])];
  _installationIds = newIds;
  try {
    const existing = loadOAuthState() ?? {};
    saveOAuthState({ ...existing, installationIds: newIds });
  } catch {
    // ignore
  }

  // Fetch installation details (best-effort)
  let installDetails = null;
  try {
    if (isAppConfigured()) {
      const jwt = signAppJWT();
      const r = await fetch(
        `https://api.github.com/app/installations/${installationId}`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "bosun-ve",
          },
        },
      );
      if (r.ok) installDetails = await r.json();
    }
  } catch {
    // Non-critical
  }

  const accountName = installDetails?.account?.login ?? `#${installationId}`;
  const repoCount = installDetails?.repositories_count ?? "?";

  const actionLabel =
    setupAction === "update" ? "updated" : "installed";

  const body = `
    <div class="alert alert-success">✓ GitHub App ${actionLabel} successfully!</div>
    <div class="card">
      <div class="card-title">Installation Details</div>
      <div class="status-row">
        <div class="dot dot-green"></div>
        <span>Account: <strong>${accountName}</strong></span>
      </div>
      <div class="status-row">
        <div class="dot dot-green"></div>
        <span>Installation ID: <strong>${installationId}</strong></span>
      </div>
      <div class="status-row">
        <div class="dot dot-green"></div>
        <span>Repositories: <strong>${repoCount}</strong></span>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Next Steps</div>
      <ol>
        <li>Set <code>BOSUN_GITHUB_APP_ID=2911413</code> and <code>BOSUN_GITHUB_PRIVATE_KEY_PATH</code> (path to your downloaded .pem file) to enable App JWT signing.</li>
        <li>Start Bosun: <code>node cli.mjs</code></li>
      </ol>
      <div class="alert alert-info" style="margin-top:12px">
        Webhook events (PR comments, issue mentions) are delivered by VirtEngine’s relay
        to your Bosun instance automatically — no public URL or tunnel needed on your end.
      </div>
      <div class="btn-row">
        <a class="btn btn-primary" href="/">← Back to portal</a>
      </div>
    </div>
  `;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(htmlPage("Setup Complete", body));
}

async function handleWebhook(req, res) {
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Failed to read body" }));
    return;
  }

  const sig = req.headers["x-hub-signature-256"] ?? "";
  if (!verifyAppWebhookSignature(rawBody, sig)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Invalid signature" }));
    return;
  }

  const eventType = req.headers["x-github-event"] ?? "unknown";
  let payload = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
    return;
  }

  handleWebhookEvent(eventType, payload);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function handleWebhookEvent(eventType, payload) {
  const action = payload?.action;

  switch (eventType) {
    case "installation":
      webhookEvents.emit("github:installation", { action, payload });
      break;

    case "installation_repositories":
      webhookEvents.emit("github:installation_repositories", {
        action,
        added: payload.repositories_added ?? [],
        removed: payload.repositories_removed ?? [],
        payload,
      });
      break;

    case "issue_comment":
      if (action === "created") {
        processBosunCommand(payload?.comment?.body ?? "", payload);
      }
      webhookEvents.emit("github:issue_comment", { action, payload });
      break;

    case "pull_request_review_comment":
      processBosunCommand(payload?.comment?.body ?? "", payload);
      webhookEvents.emit("github:pull_request_review_comment", {
        action,
        payload,
      });
      break;

    case "pull_request":
      if (action === "opened" || action === "synchronize") {
        webhookEvents.emit("github:pull_request", { action, payload });
      }
      break;

    case "push":
      webhookEvents.emit("github:push", { payload });
      break;

    default:
      webhookEvents.emit(`github:${eventType}`, { action, payload });
  }
}

const CMD_RE = /\/bosun[ \t]+(\w+)(?:[ \t]+(\S+))?/g;
const MENTION_RE = /@bosun-ve/i;

function processBosunCommand(body, payload) {
  if (MENTION_RE.test(body)) {
    webhookEvents.emit("bosun:mention", { body, payload });
  }

  CMD_RE.lastIndex = 0;
  let match;
  while ((match = CMD_RE.exec(body)) !== null) {
    const [, cmd, arg] = match;
    switch (cmd.toLowerCase()) {
      case "status":
        webhookEvents.emit("bosun:command:status", { payload });
        break;
      case "run":
        webhookEvents.emit("bosun:command:run", { taskId: arg ?? null, payload });
        break;
      case "retry":
        webhookEvents.emit("bosun:command:retry", { payload });
        break;
      default:
        webhookEvents.emit(`bosun:command:${cmd.toLowerCase()}`, {
          arg,
          payload,
        });
    }
  }
}

async function handleApiStatus(req, res) {
  const state = loadOAuthState();
  const appId = getAppId();

  const status = {
    configured: isAppConfigured() || isOAuthConfigured(),
    authenticated: Boolean(state?.accessToken),
    user: state?.user ?? null,
    installationCount: (state?.installationIds ?? []).length,
    webhookSecret: Boolean(process.env.BOSUN_GITHUB_WEBHOOK_SECRET),
    appId,
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status, null, 2));
}

async function handleApiInstallations(req, res) {
  if (!isAppConfigured()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "App JWT not configured (App ID + private key required)" }),
    );
    return;
  }

  try {
    const jwt = signAppJWT();
    const r = await fetch("https://api.github.com/app/installations?per_page=100", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bosun-ve",
      },
    });

    if (!r.ok) {
      const body = await r.text();
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `GitHub API error ${r.status}`, detail: body }));
      return;
    }

    const installations = await r.json();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(installations, null, 2));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── .env updater ─────────────────────────────────────────────────────────────

function updateEnvFile(key, value) {
  // Try to find .env relative to CWD, then one level up
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", ".env"),
  ];
  const envPath = candidates.find((p) => existsSync(p));
  if (!envPath) return; // no .env file found, skip silently

  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    // Couldn't read
  }

  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content += (content.endsWith("\n") ? "" : "\n") + line + "\n";
  }

  writeFileSync(envPath, content, "utf8");
}

// ── Router ────────────────────────────────────────────────────────────────────

async function router(req, res) {
  const url = req.url?.split("?")[0] ?? "/";
  const method = req.method?.toUpperCase() ?? "GET";

  try {
    if (method === "GET" && url === "/") {
      return await handleHome(req, res);
    }
    if (method === "GET" && url === "/github/install") {
      return handleInstall(req, res);
    }
    if (method === "GET" && url === "/github/callback") {
      return await handleCallback(req, res);
    }
    if (method === "GET" && url === "/github/setup") {
      return await handleSetup(req, res);
    }
    if (method === "POST" && url === "/webhook") {
      return await handleWebhook(req, res);
    }
    if (method === "GET" && url === "/api/status") {
      return await handleApiStatus(req, res);
    }
    if (method === "GET" && url === "/api/installations") {
      return await handleApiInstallations(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[oauth-portal] Unhandled route error:", err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

/** @type {import('node:http').Server|null} */
let _server = null;
let _port = DEFAULT_PORT;

/**
 * Starts the OAuth portal HTTP server.
 *
 * @param {{ port?: number, host?: string, quiet?: boolean }} [options]
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, webhookEvents: EventEmitter }>}
 */
export async function startOAuthPortal(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const quiet = options.quiet ?? false;

  if (_server) {
    return {
      server: _server,
      port: _port,
      url: `http://${host}:${_port}`,
      webhookEvents,
    };
  }

  return new Promise((resolve, reject) => {
    const server = createServer(router);

    server.once("error", (err) => {
      reject(err);
    });

    server.listen(port, host, () => {
      _server = server;
      _port = /** @type {import('net').AddressInfo} */ (server.address()).port;

      if (!quiet) {
        console.log(`[oauth-portal] Running at http://${host}:${_port}`);
        console.log(`[oauth-portal]   Callback URL: http://${host}:${_port}/github/callback  ← register in GitHub App settings`);
        console.log(`[oauth-portal]   Setup URL:    leave blank (superseded by Callback URL when OAuth-at-install is ON)`);
        console.log(`[oauth-portal]   Device Flow:  enable AFTER saving Callback URL in GitHub App settings`);
      }

      resolve({
        server,
        port: _port,
        url: `http://${host}:${_port}`,
        webhookEvents,
      });
    });
  });
}

/**
 * Stops the OAuth portal server.
 * @returns {Promise<void>}
 */
export async function stopOAuthPortal() {
  if (!_server) return;
  return new Promise((resolve, reject) => {
    _server.close((err) => {
      _server = null;
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Returns true if the portal appears to be listening on the given port.
 * Performs a lightweight TCP probe (attempts a fetch to /api/status).
 *
 * @param {number} [port=54317]
 * @returns {Promise<boolean>}
 */
export async function isPortalRunning(port = DEFAULT_PORT) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    try {
      const r = await fetch(`http://${DEFAULT_HOST}:${port}/api/status`, {
        signal: ctrl.signal,
      });
      return r.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
