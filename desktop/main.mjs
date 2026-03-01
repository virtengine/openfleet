import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  shell,
  Tray,
  globalShortcut,
  ipcMain,
  session,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createUnavailableShortcutsApi() {
  const unavailable = () => ({
    ok: false,
    error: "Keyboard shortcuts module is unavailable in this installation. Reinstall Bosun.",
  });
  return {
    initShortcuts: () => {},
    onShortcut: () => {},
    getAllShortcuts: () => [],
    getEffectiveAccelerator: () => null,
    registerGlobalShortcuts: () => {},
    unregisterGlobalShortcuts: () => {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* ignore */
      }
    },
    setShortcut: unavailable,
    resetShortcut: unavailable,
    resetAllShortcuts: unavailable,
  };
}

function isMissingModuleError(error) {
  return Boolean(error && error.code === "ERR_MODULE_NOT_FOUND");
}

async function loadShortcutsApi() {
  const candidates = ["./desktop-shortcuts.mjs", "../desktop-shortcuts.mjs"];
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch (error) {
      if (isMissingModuleError(error)) continue;
      throw error;
    }
  }

  console.warn(
    "[desktop] keyboard shortcuts module not found; continuing with limited shortcut support",
  );
  return createUnavailableShortcutsApi();
}

const {
  initShortcuts,
  onShortcut,
  getAllShortcuts,
  getEffectiveAccelerator,
  registerGlobalShortcuts,
  unregisterGlobalShortcuts,
  setShortcut,
  setShortcutScope,
  resetShortcut,
  resetAllShortcuts,
} = await loadShortcutsApi();

process.title = "bosun-desktop";

let mainWindow = null;
let followWindow = null;
let tray = null;
let followWindowLaunchSignature = "";
let shuttingDown = false;
let uiServerStarted = false;
let uiOrigin = null;
let uiApi = null;
let runtimeConfigLoaded = false;
/** True when the app is running as a persistent background / tray resident. */
let trayMode = false;
/** True when the main window should start hidden (background mode). */
let startHidden = false;
const DEFAULT_TELEGRAM_UI_PORT = 3080;

// ── Workspace cache (module-scope — refreshed by fetchWorkspaces) ─────────────
/** @type {{ id: string, name: string, [key: string]: unknown }[]} */
let _cachedWorkspaces = [];
let _cachedActiveWorkspaceId = /** @type {string|null} */ (null);
let _workspaceCacheAt = 0;
const WORKSPACE_CACHE_TTL_MS = 30_000;

/**
 * Shorthand: returns the effective accelerator for a shortcut ID.
 * Used throughout buildAppMenu() and refreshTrayMenu() so the menu
 * always reflects the user's current shortcut customizations.
 *
 * @param {string} id  Shortcut ID from DEFAULT_SHORTCUTS catalog.
 * @returns {string|undefined}  Accelerator string, or undefined if disabled.
 */
const acc = (id) => getEffectiveAccelerator(id) ?? undefined;

const DAEMON_PID_FILE = resolve(homedir(), ".cache", "bosun", "daemon.pid");
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

// Local/private-network patterns — TLS cert bypass for the embedded UI server
const LOCAL_HOSTNAME_RE = [
  /^127\./,
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^::1$/,
  /^localhost$/i,
];
function isLocalHost(hostname) {
  return LOCAL_HOSTNAME_RE.some((re) => re.test(hostname));
}

function isTrustedCaptureOrigin(originLike) {
  const raw = String(originLike || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").trim();
    if (!host) return false;
    if (isLocalHost(host)) return true;
    if (uiOrigin) {
      const active = new URL(uiOrigin);
      return (
        String(active.protocol || "").toLowerCase() === String(parsed.protocol || "").toLowerCase()
        && String(active.host || "").toLowerCase() === String(parsed.host || "").toLowerCase()
      );
    }
    return false;
  } catch {
    return false;
  }
}

function installDesktopMediaHandlers() {
  const ses = session.defaultSession;
  if (!ses) return;

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const p = String(permission || "").trim().toLowerCase();
    const sensitive = new Set(["media", "display-capture", "audio-capture", "video-capture"]);
    if (!sensitive.has(p)) return true;
    return isTrustedCaptureOrigin(requestingOrigin);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const p = String(permission || "").trim().toLowerCase();
    const sensitive = new Set(["media", "display-capture", "audio-capture", "video-capture"]);
    if (!sensitive.has(p)) {
      callback(true);
      return;
    }
    const allowed = isTrustedCaptureOrigin(details?.requestingOrigin || webContents?.getURL?.());
    callback(allowed);
  });

  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        // Prefer OS picker when available; this callback is used as fallback.
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!Array.isArray(sources) || !sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      } catch (err) {
        console.warn("[desktop] display media request failed:", err?.message || err);
        callback({});
      }
    },
    { useSystemPicker: true },
  );
}

/**
 * Detect whether a graphical display environment is available.
 * On Windows and macOS this is always true.
 * On Linux we probe for an X11 / Wayland display server.
 */
function isGuiEnvironment() {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  // Linux / BSD: check for a display server
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  // Running inside a desktop session without a forwarded $DISPLAY is possible
  // (e.g. XDG_SESSION_TYPE=wayland without WAYLAND_DISPLAY being exported).
  if (process.env.XDG_SESSION_TYPE && process.env.XDG_SESSION_TYPE !== "tty") return true;
  return false;
}

/**
 * Returns true when the app should run as a persistent tray resident.
 * Opt-out: set BOSUN_DESKTOP_TRAY=0 / BOSUN_DESKTOP_NO_TRAY=1
 * Explicit opt-in: BOSUN_DESKTOP_TRAY=1
 * Default: enabled on any GUI environment.
 */
function isTrayModeEnabled() {
  if (parseBoolEnv(process.env.BOSUN_DESKTOP_NO_TRAY, false)) return false;
  const explicit = process.env.BOSUN_DESKTOP_TRAY;
  if (explicit !== undefined && explicit !== "") {
    return parseBoolEnv(explicit, true);
  }
  return isGuiEnvironment();
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME
    || process.env.WSL_INTEROP
    || (process.platform === "win32"
      && String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
}

function resolveDesktopConfigDir() {
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);

  const preferWindowsDirs = process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || homedir()
    : process.env.HOME
      || process.env.XDG_CONFIG_HOME
      || process.env.USERPROFILE
      || process.env.APPDATA
      || process.env.LOCALAPPDATA
      || homedir();

  return resolve(baseDir, "bosun");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDaemonPid() {
  try {
    if (!existsSync(DAEMON_PID_FILE)) return null;
    const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return null;
    return isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function findGhostDaemonPids() {
  if (process.platform === "win32") {
    try {
      const cmd = [
        "$ErrorActionPreference='Stop';",
        "$procs = Get-CimInstance Win32_Process | Where-Object {",
        "  $_.Name -match '^(node|node\\.exe)$' -and",
        "  $_.CommandLine -and",
        "  ($_.CommandLine -match '--daemon-child' -or $_.CommandLine -match 'BOSUN_DAEMON=1')",
        "};",
        "$procs | ForEach-Object { $_.ProcessId }",
      ].join(" ");
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3500 },
      ).trim();
      if (!out) return [];
      return out
        .split(/\r?\n/)
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", "bosun.*--daemon-child|cli\\.mjs.*--daemon-child"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
    ).trim();
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

async function waitForDaemon(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = getDaemonPid();
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function resolveBosunRoot() {
  if (app.isPackaged) {
    return resolve(process.resourcesPath, "bosun");
  }
  return resolve(__dirname, "..");
}

function resolveBosunRuntimePath(file) {
  return resolve(resolveBosunRoot(), file);
}

function resolveDesktopIconPath() {
  const candidates = [
    resolveBosunRuntimePath("logo.png"),
    resolveBosunRuntimePath("ui/logo.png"),
    resolve(__dirname, "..", "ui", "logo.png"),
    resolve(__dirname, "..", "logo.png"),
  ];
  return candidates.find((iconPath) => existsSync(iconPath)) || null;
}

function buildLoadingPageUrl(message = "Starting Bosun...") {
  const safeMessage = String(message || "Starting Bosun...")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Bosun Desktop</title>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #121a24;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #4f8cff;
      --border: #243041;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(1200px 600px at 10% -10%, rgba(79,140,255,0.20), transparent 55%), var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Inter, system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }
    .card {
      width: min(520px, 96vw);
      border: 1px solid var(--border);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      padding: 22px 20px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.40);
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      margin: 0 0 12px;
      letter-spacing: 0.2px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 2px solid rgba(79,140,255,0.30);
      border-top-color: var(--accent);
      animation: spin 900ms linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .message {
      margin: 0;
      font-size: 14px;
      color: var(--text);
    }
    .hint {
      margin: 12px 0 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="title">Bosun Desktop</h1>
    <div class="row">
      <div class="spinner" aria-hidden="true"></div>
      <p id="bosun-loading-message" class="message">${safeMessage}</p>
    </div>
    <p class="hint">First launch can take 5-10 seconds while Bosun services start in the background.</p>
  </div>
</body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

async function setLoadingMessage(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const safe = JSON.stringify(String(message || "Starting Bosun..."));
  try {
    await mainWindow.webContents.executeJavaScript(
      `(function () {
        var el = document.getElementById('bosun-loading-message');
        if (el) el.textContent = ${safe};
      })()`,
      true,
    );
  } catch {
    // best effort
  }
}

function encodeFollowParam(value) {
  const normalized = String(value || "").trim();
  return normalized;
}

function buildFollowWindowUrl(baseUrl, detail = {}) {
  const target = new URL(baseUrl);
  target.searchParams.set("follow", "1");
  target.searchParams.set("launch", "voice");
  target.searchParams.set(
    "call",
    String(detail.call || "").trim().toLowerCase() === "video"
      ? "video"
      : "voice",
  );
  const sessionId = encodeFollowParam(detail.sessionId);
  const executor = encodeFollowParam(detail.executor);
  const mode = encodeFollowParam(detail.mode);
  const model = encodeFollowParam(detail.model);
  const vision = encodeFollowParam(detail.initialVisionSource);
  if (sessionId) target.searchParams.set("sessionId", sessionId);
  if (executor) target.searchParams.set("executor", executor);
  if (mode) target.searchParams.set("mode", mode);
  if (model) target.searchParams.set("model", model);
  if (vision) target.searchParams.set("vision", vision);
  return target;
}

function setWindowVisible(win) {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(false);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

/**
 * Make an authenticated JSON request to the UI server.
 * Returns the parsed response body, or null on error.
 * @param {string} urlStr
 * @param {{ method?: string, body?: string }} [opts]
 */
function uiServerRequest(urlStr, { method = "GET", body } = {}) {
  return new Promise((resolve) => {
    try {
      const isHttps = urlStr.startsWith("https://");
      const desktopKey = process.env.BOSUN_DESKTOP_API_KEY || "";
      const headers = /** @type {Record<string, string>} */ ({
        Authorization: `Bearer ${desktopKey}`,
        "Content-Type": "application/json",
      });
      if (body) headers["Content-Length"] = String(Buffer.byteLength(body));
      const req = (isHttps ? httpsRequest : httpRequest)(
        urlStr,
        { method, headers, timeout: 5000, rejectUnauthorized: false },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { buf += chunk; });
          res.on("end", () => {
            try { resolve(JSON.parse(buf)); }
            catch { resolve(null); }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      if (body) req.write(body);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Fetch workspace list from the UI server and update the module-scope cache.
 * Respects a 30-second TTL to avoid hammering the server.
 * @param {{ force?: boolean }} [opts]
 */
async function fetchWorkspaces({ force = false } = {}) {
  if (!uiOrigin) return _cachedWorkspaces;
  const now = Date.now();
  if (!force && _workspaceCacheAt > 0 && now - _workspaceCacheAt < WORKSPACE_CACHE_TTL_MS) {
    return _cachedWorkspaces;
  }
  const data = await uiServerRequest(`${uiOrigin}/api/workspaces`);
  if (data?.ok && Array.isArray(data.data)) {
    _cachedWorkspaces = data.data;
    _cachedActiveWorkspaceId = data.activeId || null;
    _workspaceCacheAt = Date.now();
  }
  return _cachedWorkspaces;
}

/**
 * Switch the active workspace and refresh menus.
 * @param {string} workspaceId
 */
async function switchWorkspace(workspaceId) {
  if (!uiOrigin || !workspaceId) return;
  const body = JSON.stringify({ workspaceId });
  const data = await uiServerRequest(`${uiOrigin}/api/workspaces/active`, {
    method: "POST",
    body,
  });
  if (data?.ok) {
    _cachedActiveWorkspaceId = workspaceId;
    _workspaceCacheAt = 0; // force re-fetch next time
  }
  await fetchWorkspaces({ force: true });
  Menu.setApplicationMenu(buildAppMenu());
  refreshTrayMenu();
  navigateMainWindow("/");
}

/**
 * Build workspace submenu items from the module-scope cache (sync).
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildWorkspaceSubmenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [];

  if (_cachedWorkspaces.length === 0) {
    items.push({ label: "Loading workspaces\u2026", enabled: false });
  } else {
    for (const ws of _cachedWorkspaces) {
      const wsId = String(ws.id || "");
      const wsName = String(ws.name || ws.id || "Untitled Workspace");
      const isActive = wsId === _cachedActiveWorkspaceId;
      items.push({
        label: isActive ? `\u2713 ${wsName}` : wsName,
        type: /** @type {const} */ ("normal"),
        enabled: !isActive,
        click: () => {
          switchWorkspace(wsId).catch((err) =>
            console.warn("[desktop] workspace switch failed:", err?.message || err),
          );
        },
      });
    }
  }

  items.push({ type: /** @type {const} */ ("separator") });
  items.push({
    label: "Manage Workspaces\u2026",
    click: () => navigateMainWindow("/settings"),
  });
  items.push({
    label: "Refresh List",
    click: () => {
      fetchWorkspaces({ force: true })
        .then(() => {
          Menu.setApplicationMenu(buildAppMenu());
          refreshTrayMenu();
        })
        .catch(() => {});
    },
  });
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate the main window's SPA to the given path.
 * Uses the direct `__bosunSetTab` router API when available; falls back to
 * pushState + popstate for robustness during page load.
 */
function navigateMainWindow(path) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setWindowVisible(mainWindow);
  if (!uiOrigin) return;
  // Derive SPA tab ID from the URL path. The router maps the first path
  // segment directly to a tab identifier (empty segment = "dashboard").
  const seg = String(path || "/").replace(/^\/+/, "").split("/")[0];
  const tabId = seg || "dashboard";
  const safePath = JSON.stringify(path);
  const safeTabId = JSON.stringify(tabId);
  mainWindow.webContents
    .executeJavaScript(
      `(function(){
        var tabId = ${safeTabId};
        var path  = ${safePath};
        // Primary: direct SPA router call (most reliable, bypasses history state issues)
        if (typeof window.__bosunSetTab === 'function') {
          window.__bosunSetTab(tabId);
          return;
        }
        // Fallback: pushState + popstate (for pages still loading)
        if (window.history && window.history.pushState) {
          window.history.pushState({ desktopNav: true }, '', path);
          window.dispatchEvent(new PopStateEvent('popstate', { state: { desktopNav: true } }));
        }
      })()`,
    )
    .catch(() => {});
}

/**
 * Build and return the application menu template.
 * This is called once during bootstrap and can be refreshed when
 * pack status or update state changes, or when workspaces are loaded.
 */
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const isDev = !app.isPackaged;

  const openUrl = (url) => shell.openExternal(url).catch(() => {});

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    // ── macOS app menu ──────────────────────────────────────────────────────
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: /** @type {const} */ ("about") },
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("services") },
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("hide") },
              { role: /** @type {const} */ ("hideOthers") },
              { role: /** @type {const} */ ("unhide") },
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("quit") },
            ],
          },
        ]
      : []),

    // ── File ────────────────────────────────────────────────────────────────
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: acc("app.newchat"),
          click: () => navigateMainWindow("/chat"),
        },
        { type: /** @type {const} */ ("separator") },
        isMac
          ? { role: /** @type {const} */ ("close") }
          : { role: /** @type {const} */ ("quit") },
      ],
    },

    // ── Edit ────────────────────────────────────────────────────────────────
    { role: /** @type {const} */ ("editMenu") },

    // ── View ────────────────────────────────────────────────────────────────
    {
      label: "View",
      submenu: [
        { role: /** @type {const} */ ("reload") },
        { role: /** @type {const} */ ("forceReload") },
        { type: /** @type {const} */ ("separator") },
        { role: /** @type {const} */ ("resetZoom") },
        { role: /** @type {const} */ ("zoomIn") },
        { role: /** @type {const} */ ("zoomOut") },
        { type: /** @type {const} */ ("separator") },
        { role: /** @type {const} */ ("togglefullscreen") },
        ...(isDev
          ? [
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("toggleDevTools") },
            ]
          : []),
      ],
    },

    // ── Go (full SPA navigation) ─────────────────────────────────────────────
    {
      label: "Go",
      submenu: [
        {
          label: "Dashboard",
          accelerator: acc("bosun.navigate.home"),
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Chat \u0026 Sessions",
          accelerator: acc("bosun.navigate.chat"),
          click: () => navigateMainWindow("/chat"),
        },
        {
          label: "Tasks",
          accelerator: acc("bosun.navigate.tasks"),
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Workflows",
          accelerator: acc("bosun.navigate.workflows"),
          click: () => navigateMainWindow("/workflows"),
        },
        {
          label: "Agents",
          accelerator: acc("bosun.navigate.agents"),
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Fleet Sessions",
          accelerator: acc("bosun.navigate.fleet"),
          click: () => navigateMainWindow("/fleet-sessions"),
        },
        {
          label: "Control Panel",
          accelerator: acc("bosun.navigate.control"),
          click: () => navigateMainWindow("/control"),
        },
        {
          label: "Infrastructure",
          accelerator: acc("bosun.navigate.infra"),
          click: () => navigateMainWindow("/infra"),
        },
        {
          label: "Logs",
          accelerator: acc("bosun.navigate.logs"),
          click: () => navigateMainWindow("/logs"),
        },
        {
          label: "Library",
          accelerator: acc("bosun.navigate.library"),
          click: () => navigateMainWindow("/library"),
        },
        {
          label: "Telemetry",
          accelerator: acc("bosun.navigate.telemetry"),
          click: () => navigateMainWindow("/telemetry"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Settings",
          accelerator: acc("app.settings"),
          click: () => navigateMainWindow("/settings"),
        },
      ],
    },

    // ── Workspace ────────────────────────────────────────────────────────────
    {
      label: "Workspace",
      submenu: buildWorkspaceSubmenu(),
    },

    // ── Bosun ───────────────────────────────────────────────────────────────
    {
      label: "Bosun",
      submenu: [
        {
          label: "Show Main Window",
          accelerator: acc("bosun.focus"),
          click: () => setWindowVisible(mainWindow),
        },
        {
          label: "Voice Call",
          accelerator: acc("bosun.voice.call"),
          click: () => openFollowWindow({ call: "voice" }).catch(() => {}),
        },
        {
          label: "Video Call",
          accelerator: acc("bosun.voice.video"),
          click: () => openFollowWindow({ call: "video" }).catch(() => {}),
        },
        {
          label: "Toggle Voice Companion",
          accelerator: acc("bosun.voice.toggle"),
          click: () => {
            if (!restoreFollowWindow()) setWindowVisible(mainWindow);
          },
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Check for Updates",
          enabled: app.isPackaged,
          click: () => maybeAutoUpdate().catch(() => {}),
        },
      ],
    },

    // ── Window ──────────────────────────────────────────────────────────────
    { role: /** @type {const} */ ("windowMenu") },

    // ── Help ────────────────────────────────────────────────────────────────
    {
      role: /** @type {const} */ ("help"),
      submenu: [
        {
          label: "Bosun Documentation",
          click: () => openUrl("https://github.com/virtengine/bosun#readme"),
        },
        {
          label: "GitHub Repository",
          click: () => openUrl("https://github.com/virtengine/bosun"),
        },
        {
          label: "Report an Issue",
          click: () =>
            openUrl("https://github.com/virtengine/bosun/issues/new"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Keyboard Shortcuts",
          accelerator: acc("bosun.show.shortcuts"),
          click: () => showShortcutsDialog(),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => mainWindow?.webContents?.toggleDevTools(),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

async function loadBosunModule(file) {
  const modulePath = resolveBosunRuntimePath(file);
  return import(pathToFileURL(modulePath).href);
}

async function loadRuntimeConfig() {
  if (runtimeConfigLoaded) return;
  try {
    const config = await loadBosunModule("config.mjs");
    if (typeof config?.loadConfig === "function") {
      config.loadConfig(["node", "desktop"], { reloadEnv: true });
    }
  } catch (err) {
    console.warn("[desktop] failed to load config env", err?.message || err);
  }
  runtimeConfigLoaded = true;
}

async function loadUiServerModule() {
  if (uiApi) return uiApi;
  uiApi = await loadBosunModule("ui-server.mjs");
  return uiApi;
}

function buildDaemonUiBaseUrl() {
  const rawPort = Number(process.env.TELEGRAM_UI_PORT || "");
  const port = Number.isFinite(rawPort) && rawPort > 0
    ? rawPort
    : DEFAULT_TELEGRAM_UI_PORT;
  const tlsDisabled = parseBoolEnv(process.env.TELEGRAM_UI_TLS_DISABLE, false);
  const protocol = tlsDisabled ? "http" : "https";
  const host =
    process.env.TELEGRAM_UI_DESKTOP_HOST ||
    process.env.TELEGRAM_UI_HOST ||
    "127.0.0.1";
  return `${protocol}://${host}:${port}`;
}

async function probeUiServer(url) {
  return new Promise((resolve) => {
    try {
      const isHttps = url.startsWith("https://");
      const req = (isHttps ? httpsRequest : httpRequest)(
        `${url}/api/status`,
        {
          method: "GET",
          timeout: 1500,
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          resolve(Boolean(res.statusCode && res.statusCode < 500));
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/** Set to true if the daemon UI was not reachable at startup (offline mode). */
let bosunDaemonWasOffline = false;

async function resolveDaemonUiUrl() {
  const useDaemon = parseBoolEnv(
    process.env.BOSUN_DESKTOP_USE_DAEMON_UI,
    true,
  );
  if (!useDaemon) return null;
  const base = buildDaemonUiBaseUrl();
  if (!base) return null;
  const ok = await probeUiServer(base);
  return ok ? base : null;
}

/**
 * Wait for the daemon UI endpoint to become reachable.
 */
async function waitForDaemonUi(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUiServer(baseUrl)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

function spawnDetachedDaemon() {
  const cliPath = resolveBosunRuntimePath("cli.mjs");
  if (!existsSync(cliPath)) {
    throw new Error(`CLI not found at ${cliPath}`);
  }
  const child = spawn(
    process.execPath,
    [cliPath, "--daemon", "--no-update-check"],
    {
      cwd: resolveBosunRoot(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        BOSUN_DESKTOP_SPAWNED_DAEMON: "1",
      },
    },
  );
  child.unref();
  return child.pid;
}

/**
 * Ensure the daemon is running when desktop starts.
 *
 * Default behaviour: auto-start enabled.
 * Opt-out: BOSUN_DESKTOP_AUTO_START_DAEMON=0
 */
async function ensureDaemonRunning() {
  const daemonBaseUrl = buildDaemonUiBaseUrl();
  if (await probeUiServer(daemonBaseUrl)) return;

  const ghostPids = findGhostDaemonPids();
  // If a daemon is starting naturally, give it a short window first.
  const existingPid = getDaemonPid();
  if ((existingPid || ghostPids.length > 0) && await waitForDaemonUi(daemonBaseUrl, 5000)) {
    return;
  }

  const autoStart = parseBoolEnv(process.env.BOSUN_DESKTOP_AUTO_START_DAEMON, true);
  if (!autoStart) return;

  try {
    if (!existingPid && ghostPids.length === 0) {
      const pid = spawnDetachedDaemon();
      console.log(`[desktop] started bosun daemon in background (pid ${pid})`);
    } else {
      console.log("[desktop] existing bosun background process detected; not starting another instance");
    }
  } catch (error) {
    console.warn("[desktop] failed to auto-start daemon:", error?.message || error);
    return;
  }

  // Best effort wait. If it still isn't up we'll fall back to local UI mode.
  await waitForDaemonUi(daemonBaseUrl, 15000);
}

async function startUiServer() {
  if (uiServerStarted) return;
  const api = await loadUiServerModule();
  const server = await api.startTelegramUiServer({
    host: "127.0.0.1",
    publicHost: "127.0.0.1",
    skipAutoOpen: true,
    dependencies: {
      configDir: resolveDesktopConfigDir(),
    },
  });
  if (!server) {
    throw new Error("Failed to start Telegram UI server.");
  }
  uiServerStarted = true;
}

async function buildUiUrl() {
  await loadRuntimeConfig();
  const daemonUrl = await resolveDaemonUiUrl();
  if (daemonUrl) {
    uiOrigin = new URL(daemonUrl).origin;
    // Authenticate the initial WebView load against the separately-running
    // daemon using the desktop API key (set during bootstrap).
    const desktopKey = process.env.BOSUN_DESKTOP_API_KEY;
    if (desktopKey) {
      const daemonTarget = new URL(daemonUrl);
      daemonTarget.searchParams.set("desktopKey", desktopKey);
      return daemonTarget.toString();
    }
    return daemonUrl;
  }
  // Daemon is not reachable — flag it so the window can show an offline banner.
  bosunDaemonWasOffline = true;
  await startUiServer();
  const api = await loadUiServerModule();
  const uiServerUrl = api.getTelegramUiUrl();
  if (!uiServerUrl) {
    throw new Error("Telegram UI server URL is unavailable.");
  }
  const targetUrl = new URL(uiServerUrl);
  uiOrigin = targetUrl.origin;
  // Prefer the non-expiring desktop API key over the TTL-based session token.
  // Both result in the server setting a ve_session cookie and redirecting to /.
  const desktopKey = process.env.BOSUN_DESKTOP_API_KEY;
  if (desktopKey) {
    targetUrl.searchParams.set("desktopKey", desktopKey);
  } else {
    const sessionToken = api.getSessionToken();
    if (sessionToken) {
      targetUrl.searchParams.set("token", sessionToken);
    }
  }
  return targetUrl.toString();
}

async function createMainWindow() {
  if (mainWindow) return;
  const iconPath = resolveDesktopIconPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    ...(iconPath && existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    // In tray mode Windows/Linux should not show a taskbar button for the
    // hidden state — the tray icon IS the taskbar presence.
    skipTaskbar: Boolean(trayMode && startHidden),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.on("close", (event) => {
    // User close should not quit the app; minimize to taskbar/dock.
    if (shuttingDown) return;
    event.preventDefault();
    if (mainWindow?.isMinimized()) return;
    mainWindow?.setSkipTaskbar(false);
    mainWindow?.minimize();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    if (!startHidden) {
      mainWindow?.show();
    }
  });

  // When the window is shown again, make it appear in the taskbar on
  // Windows / Linux and restore the macOS dock icon.
  mainWindow.on("show", () => {
    mainWindow?.setSkipTaskbar(false);
    if (process.platform === "darwin") {
      app.dock?.show();
    }
  });

  // Always render an in-app loading screen first so startup latency
  // (daemon boot, TLS init, server warm-up) is visible to the user.
  await mainWindow.loadURL(buildLoadingPageUrl("Starting Bosun services..."));
  await setLoadingMessage("Preparing background daemon...");
  await ensureDaemonRunning();
  await setLoadingMessage("Connecting to Bosun portal...");
  const uiUrl = await buildUiUrl();
  await mainWindow.loadURL(uiUrl);

  // If the daemon UI is still offline after startup checks/auto-start, inject
  // a non-blocking banner so the user has clear recovery instructions.
  if (bosunDaemonWasOffline) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents
        .executeJavaScript(
          `(function() {
            if (document.getElementById('bosun-offline-banner')) return;
            const b = document.createElement('div');
            b.id = 'bosun-offline-banner';
            b.style.cssText = [
              'position:fixed','top:0','left:0','right:0','z-index:99999',
              'background:#7f1d1d','color:#fff','padding:10px 16px',
              'font:13px/1.5 monospace','display:flex','gap:12px',
              'align-items:center','justify-content:space-between',
            ].join(';');
            b.innerHTML = [
              '<span>',
              '\u26a0\ufe0f <strong>Bosun daemon is not reachable.</strong>',
              ' This portal is in local mode — agents & tasks from your background service are unavailable.',
              ' Start it: ',
              '<code style="background:rgba(255,255,255,.15);padding:2px 6px;border-radius:3px">bosun --daemon</code>',
              ' &bull; Configure auto-start: ',
              '<code style="background:rgba(255,255,255,.15);padding:2px 6px;border-radius:3px">bosun --setup</code>',
              '</span>',
              '<button onclick="document.getElementById(\'bosun-offline-banner\').remove()"',
              ' style="background:none;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;padding:0 4px">&times;</button>',
            ].join(' ');
            document.body.prepend(b);
          })()`
        )
        .catch(() => {});
    });
  }
}

async function createFollowWindow() {
  if (followWindow && !followWindow.isDestroyed()) return followWindow;
  const iconPath = resolveDesktopIconPath();
  followWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 340,
    minHeight: 440,
    backgroundColor: "#0b0b0c",
    ...(iconPath && existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    skipTaskbar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  followWindow.setAlwaysOnTop(true, "floating", 1);

  followWindow.on("close", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    followWindow?.hide();
  });

  followWindow.on("closed", () => {
    followWindow = null;
    followWindowLaunchSignature = "";
  });

  followWindow.once("ready-to-show", () => {
    setWindowVisible(followWindow);
  });

  return followWindow;
}

async function openFollowWindow(detail = {}) {
  const win = await createFollowWindow();
  const baseUiUrl = await buildUiUrl();
  const target = buildFollowWindowUrl(baseUiUrl, detail);
  const signature = target.toString();
  if (!win.webContents.getURL() || followWindowLaunchSignature !== signature) {
    followWindowLaunchSignature = signature;
    await win.loadURL(signature);
    return;
  }
  setWindowVisible(win);
}

function hideFollowWindow() {
  if (!followWindow || followWindow.isDestroyed()) return false;
  followWindow.hide();
  return true;
}

function restoreFollowWindow() {
  if (!followWindow || followWindow.isDestroyed()) return false;
  setWindowVisible(followWindow);
  return true;
}

/** Rebuild and apply the tray context menu (called after state changes). */
function refreshTrayMenu() {
  if (!tray) return;

  const openUrl = (url) => shell.openExternal(url).catch(() => {});
  const isDev = !app.isPackaged;

  // Build workspace items from the module-scope cache
  const workspaceItems = /** @type {Electron.MenuItemConstructorOptions[]} */ ([]);
  if (_cachedWorkspaces.length > 0) {
    for (const ws of _cachedWorkspaces) {
      const wsId = String(ws.id || "");
      const wsName = String(ws.name || ws.id || "Untitled Workspace");
      const isActive = wsId === _cachedActiveWorkspaceId;
      workspaceItems.push({
        label: isActive ? `\u2713 ${wsName}` : wsName,
        type: /** @type {const} */ ("normal"),
        enabled: !isActive,
        click: () => {
          switchWorkspace(wsId).catch((err) =>
            console.warn("[desktop] workspace switch failed:", err?.message || err),
          );
        },
      });
    }
  }

  const menu = Menu.buildFromTemplate([
    // ── Identity header ──────────────────────────────────────────────────
    {
      label: "VirtEngine",
      enabled: false,
    },
    {
      label: "Show Window",
      click: () => setWindowVisible(mainWindow),
    },
    { type: /** @type {const} */ ("separator") },

    // ── Navigation ───────────────────────────────────────────────────────
    {
      label: "Go To",
      submenu: [
        {
          label: "Dashboard",
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Chat \u0026 Sessions",
          click: () => navigateMainWindow("/chat"),
        },
        {
          label: "Tasks",
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Workflows",
          click: () => navigateMainWindow("/workflows"),
        },
        {
          label: "Agents",
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Fleet Sessions",
          click: () => navigateMainWindow("/fleet-sessions"),
        },
        {
          label: "Control Panel",
          click: () => navigateMainWindow("/control"),
        },
        {
          label: "Infrastructure",
          click: () => navigateMainWindow("/infra"),
        },
        {
          label: "Logs",
          click: () => navigateMainWindow("/logs"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Settings",
          accelerator: acc("app.settings"),
          click: () => navigateMainWindow("/settings"),
        },
      ],
    },

    // ── Workspace ────────────────────────────────────────────────────────
    ...(workspaceItems.length > 0
      ? [
          {
            label: "Workspace",
            submenu: [
              ...workspaceItems,
              { type: /** @type {const} */ ("separator") },
              {
                label: "Manage Workspaces\u2026",
                click: () => navigateMainWindow("/settings"),
              },
            ],
          },
        ]
      : []),

    // ── Voice ────────────────────────────────────────────────────────────
    {
      label: "Voice Companion",
      accelerator: acc("bosun.voice.toggle"),
      click: () => {
        if (!restoreFollowWindow()) setWindowVisible(mainWindow);
      },
    },
    {
      label: "Voice Call",
      click: () => openFollowWindow({ call: "voice" }).catch(() => {}),
    },
    { type: /** @type {const} */ ("separator") },

    {
      label: "Restart to Apply Update",
      enabled: app.isPackaged,
      click: () => {
        app.relaunch();
        void shutdown("tray_restart_update");
      },
    },

    // ── Troubleshooting ──────────────────────────────────────────────────
    {
      label: "Troubleshooting",
      submenu: [
        {
          label: "Reload UI",
          click: () => mainWindow?.webContents?.reload(),
        },
        {
          label: "Force Reload UI",
          click: () => mainWindow?.webContents?.reloadIgnoringCache(),
        },
        {
          label: "Clear Cache \u0026 Reload",
          click: async () => {
            try {
              await session.defaultSession.clearCache();
            } catch {
              // best effort
            }
            mainWindow?.webContents?.reloadIgnoringCache();
          },
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Toggle Developer Tools",
          enabled: isDev || !app.isPackaged,
          click: () => mainWindow?.webContents?.toggleDevTools(),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "View Logs",
          click: () => navigateMainWindow("/logs"),
        },
        {
          label: "Report an Issue",
          click: () =>
            openUrl("https://github.com/virtengine/bosun/issues/new"),
        },
      ],
    },
    { type: /** @type {const} */ ("separator") },

    // ── Startup / login ──────────────────────────────────────────────
    ...(app.isPackaged
      ? [
          {
            label: "Start at Login",
            type: /** @type {const} */ ("checkbox"),
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => {
              app.setLoginItemSettings({ openAtLogin: item.checked });
            },
          },
        ]
      : []),
    { type: /** @type {const} */ ("separator") },

    // ── Quit ───────────────────────────────────────────────────────────
    {
      label: "Quit",
      accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
      click: () => {
        void shutdown("tray_quit");
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function ensureTray() {
  if (tray) return;
  const iconPath = resolveDesktopIconPath();
  if (!iconPath || !existsSync(iconPath)) return;

  tray = new Tray(iconPath);
  tray.setToolTip("Bosun — AI Control Center");

  refreshTrayMenu();

  // Single click: show/restore the main window (or follow window).
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
        if (process.platform === "darwin") app.dock?.hide();
      } else {
        setWindowVisible(mainWindow);
      }
    } else {
      void createMainWindow();
    }
  });

  // Double-click on Windows brings up the window unambiguously.
  tray.on("double-click", () => {
    setWindowVisible(mainWindow);
  });
}

/**
 * Display a native shortcuts reference dialog.
 * Groups shortcuts by their group property so the list is easy to scan.
 */
function showShortcutsDialog() {
  const shortcuts = getAllShortcuts();

  // Group entries
  /** @type {Map<string, typeof shortcuts>} */
  const groups = new Map();
  for (const s of shortcuts) {
    const g = s.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  const isMac = process.platform === "darwin";
  const modSymbol = isMac ? "⌘" : "Ctrl";
  const shiftSym = isMac ? "⇧" : "+Shift";

  const lines = [];
  for (const [group, items] of groups) {
    lines.push(`── ${group} ──`);
    for (const s of items) {
      const display = s.isDisabled
        ? "(disabled)"
        : (s.accelerator ?? "(none)")
            .replace(/CmdOrCtrl/g, modSymbol)
            .replace(/CommandOrControl/g, modSymbol)
            .replace(/Shift\+/g, `${shiftSym}+`);
      const custom = s.isCustomized ? " ★" : "";
      lines.push(`  ${s.label.padEnd(30)} ${display}${custom}`);
    }
    lines.push("");
  }
  lines.push("★ = customized from default");
  lines.push("");
  lines.push("To customize shortcuts, edit:");
  lines.push(`  ${resolveDesktopConfigDir()}/desktop-shortcuts.json`);

  dialog
    .showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "Bosun — Keyboard Shortcuts",
      message: "Keyboard Shortcuts Reference",
      detail: lines.join("\n"),
      buttons: ["OK"],
    })
    .catch(() => {});
}

/**
 * Wire all shortcut action handlers and register global shortcuts.
 * Called once during bootstrap, after the config dir is known.
 *
 * @param {string} configDir
 */
function initAndRegisterShortcuts(configDir) {
  // Initialise the shortcuts manager (loads user customizations).
  initShortcuts(configDir);

  // ── Register action handlers ───────────────────────────────────────────
  // Global: fire from anywhere on the desktop
  onShortcut("bosun.focus", () => {
    setWindowVisible(mainWindow);
  });

  onShortcut("bosun.quickchat", () => {
    setWindowVisible(mainWindow);
    navigateMainWindow("/chat");
  });

  onShortcut("bosun.voice.call", () => {
    openFollowWindow({ call: "voice" }).catch((err) =>
      console.warn("[shortcuts] voice.call failed:", err?.message || err),
    );
  });

  onShortcut("bosun.voice.video", () => {
    openFollowWindow({ call: "video" }).catch((err) =>
      console.warn("[shortcuts] voice.video failed:", err?.message || err),
    );
  });

  onShortcut("bosun.voice.toggle", () => {
    if (!restoreFollowWindow()) setWindowVisible(mainWindow);
  });

  // Local: navigation (also in menu, but registered here for completeness)
  onShortcut("bosun.navigate.home", () => navigateMainWindow("/"));
  onShortcut("bosun.navigate.chat", () => navigateMainWindow("/chat"));
  onShortcut("bosun.navigate.tasks", () => navigateMainWindow("/tasks"));
  onShortcut("bosun.navigate.workflows", () => navigateMainWindow("/workflows"));
  onShortcut("bosun.navigate.agents", () => navigateMainWindow("/agents"));
  onShortcut("bosun.navigate.fleet", () => navigateMainWindow("/fleet-sessions"));
  onShortcut("bosun.navigate.control", () => navigateMainWindow("/control"));
  onShortcut("bosun.navigate.infra", () => navigateMainWindow("/infra"));
  onShortcut("bosun.navigate.logs", () => navigateMainWindow("/logs"));
  onShortcut("bosun.navigate.library", () => navigateMainWindow("/library"));
  onShortcut("bosun.navigate.telemetry", () => navigateMainWindow("/telemetry"));
  onShortcut("bosun.navigate.settings", () => navigateMainWindow("/settings"));
  onShortcut("app.newchat", () => navigateMainWindow("/chat"));
  onShortcut("app.settings", () => navigateMainWindow("/settings"));
  onShortcut("bosun.show.shortcuts", () => showShortcutsDialog());

  // ── Register global shortcuts with the OS ────────────────────────────
  registerGlobalShortcuts();
}

function registerDesktopIpc() {
  ipcMain.handle("bosun:desktop:follow:open", async (_event, detail) => {
    await openFollowWindow(detail || {});
    return { ok: true };
  });
  ipcMain.handle("bosun:desktop:follow:hide", async () => {
    return { ok: hideFollowWindow() };
  });
  ipcMain.handle("bosun:desktop:follow:restore", async () => {
    return { ok: restoreFollowWindow() };
  });

  // ── Shortcuts IPC ───────────────────────────────────────────────────
  /** Returns the full shortcuts catalog with effective accelerators. */
  ipcMain.handle("bosun:shortcuts:list", () => getAllShortcuts());

  /**
   * Set a custom accelerator for a shortcut.
   * Payload: { id: string, accelerator: string | null }
   * Pass null to disable the shortcut.
   * Returns: { ok: boolean, error?: string }
   * Side-effects: re-registers global shortcuts + rebuilds the app menu.
   */
  ipcMain.handle("bosun:shortcuts:set", (_event, { id, accelerator }) => {
    const result = setShortcut(id, accelerator);
    if (result.ok) {
      // Rebuild the menu so the new accelerator is reflected immediately.
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
    }
    return result;
  });

  /**
   * Reset a single shortcut to its default.
   * Payload: { id: string }
   */
  ipcMain.handle("bosun:shortcuts:reset", (_event, { id }) => {
    const result = resetShortcut(id);
    if (result.ok) {
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
    }
    return result;
  });

  /** Reset ALL shortcuts to defaults. */
  ipcMain.handle("bosun:shortcuts:resetAll", () => {
    const result = resetAllShortcuts();
    if (result.ok) {
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
    }
    return result;
  });

  /** Show the native keyboard shortcuts reference dialog. */
  ipcMain.handle("bosun:shortcuts:showDialog", () => {
    showShortcutsDialog();
    return { ok: true };
  });

  /**
   * Enable or disable global (system-wide) firing for a globalEligible shortcut.
   * Payload: { id: string, isGlobal: boolean }
   * Returns: { ok: boolean, error?: string }
   */
  ipcMain.handle("bosun:shortcuts:setScope", (_event, { id, isGlobal }) => {
    return setShortcutScope(id, Boolean(isGlobal));
  });

  // ── Navigation IPC ───────────────────────────────────────────────────────
  /**
   * Navigate the main window to a given path or tab ID.
   * Payload: { path: string } e.g. { path: "/chat" } or { path: "chat" }
   */
  ipcMain.handle("bosun:navigate", (_event, { path } = {}) => {
    if (!path) return { ok: false, error: "path required" };
    const normalizedPath = String(path).startsWith("/") ? path : `/${path}`;
    navigateMainWindow(normalizedPath);
    return { ok: true };
  });

  // ── Workspace IPC ────────────────────────────────────────────────────────
  /** Returns the cached workspace list and active workspace ID. */
  ipcMain.handle("bosun:workspaces:list", async () => {
    await fetchWorkspaces();
    return {
      ok: true,
      workspaces: _cachedWorkspaces,
      activeId: _cachedActiveWorkspaceId,
    };
  });

  /**
   * Switch the active workspace.
   * Payload: { workspaceId: string }
   */
  ipcMain.handle("bosun:workspaces:switch", async (_event, { workspaceId } = {}) => {
    if (!workspaceId) return { ok: false, error: "workspaceId required" };
    await switchWorkspace(workspaceId);
    return { ok: true, activeId: workspaceId };
  });
}

async function bootstrap() {
  try {
    // Register cert bypass for the local UI server as the very first operation
    // — before any network request is made (config loading, API key probe, etc.).
    // allow-insecure-localhost (set pre-ready above) handles 127.0.0.1; this
    // setCertificateVerifyProc covers LAN IPs (192.168.x.x / 10.x etc.).
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      if (isLocalHost(request.hostname)) {
        callback(0); // 0 = verified OK
        return;
      }
      callback(-3); // -3 = use Chromium default chain verification
    });
    installDesktopMediaHandlers();

    if (process.env.ELECTRON_DISABLE_SANDBOX === "1") {
      app.commandLine.appendSwitch("no-sandbox");
      app.commandLine.appendSwitch("disable-gpu-sandbox");
    }
    app.setAppUserModelId("com.virtengine.bosun");
    const iconPath = resolveDesktopIconPath();
    if (iconPath && existsSync(iconPath)) {
      try {
        app.setIcon(iconPath);
      } catch {
        /* best effort */
      }
    }
    process.chdir(resolveBosunRoot());
    await loadRuntimeConfig();

    // Provision (or reload) the dedicated Electron desktop API key.
    // The key is stored at {configDir}/desktop-api-key.json and is set in
    // process.env so that the in-process UI server can validate it without
    // importing the module directly (avoids circular dependency).
    try {
      const keyMod = await loadBosunModule("desktop-api-key.mjs");
      const desktopApiKey = keyMod.ensureDesktopApiKey(resolveDesktopConfigDir());
      process.env.BOSUN_DESKTOP_API_KEY = desktopApiKey;
    } catch (err) {
      console.warn("[desktop] could not load desktop-api-key module:", err?.message || err);
    }

    // Initialise shortcuts (loads user config) and register globals.
    // Must happen before buildAppMenu() so acc() returns correct values.
    initAndRegisterShortcuts(resolveDesktopConfigDir());

    Menu.setApplicationMenu(buildAppMenu());

    // Determine tray / background mode before creating any windows.
    trayMode = isTrayModeEnabled();
    // Launch visible by default; allow opt-in hidden start only.
    // Set BOSUN_DESKTOP_START_HIDDEN=1 to keep legacy background startup.
    startHidden = trayMode
      ? parseBoolEnv(process.env.BOSUN_DESKTOP_START_HIDDEN, false)
      : false;

    if (trayMode) {
      // Always create the tray icon first so the app has a presence even
      // before the window is ready.
      ensureTray();
      // On macOS, hide the dock icon in background mode unless the user has
      // explicitly disabled it.
      if (
        process.platform === "darwin"
        && !parseBoolEnv(process.env.BOSUN_DESKTOP_SHOW_DOCK, false)
      ) {
        app.dock?.hide();
      }
    }

    registerDesktopIpc();
    await createMainWindow();

    // In normal (non-background) mode the tray is still useful as an
    // indicator and quick-access — create it after the window is up.
    if (!trayMode) {
      ensureTray();
    }

    // Fetch workspace list in the background so the menu and tray show
    // workspace switcher items as soon as the UI server is reachable.
    fetchWorkspaces({ force: true })
      .then(() => {
        Menu.setApplicationMenu(buildAppMenu());
        refreshTrayMenu();
      })
      .catch((err) =>
        console.warn("[desktop] initial workspace fetch:", err?.message || err),
      );

    await maybeAutoUpdate();
  } catch (error) {
    console.error("[desktop] startup failed", error);
    await shutdown("startup_failed");
  }
}

async function maybeAutoUpdate() {
  if (!app.isPackaged) return;
  if (process.env.BOSUN_DESKTOP_AUTO_UPDATE !== "1") return;
  try {
    const { autoUpdater } = await import("electron-updater");
    const feedUrl = process.env.BOSUN_DESKTOP_UPDATE_URL;
    if (feedUrl) {
      autoUpdater.setFeedURL({ url: feedUrl });
    }
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (err) {
    console.warn("[desktop] auto-update unavailable", err?.message || err);
  }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (reason) {
    console.log(`[desktop] shutting down (${reason})`);
  }

  try {
    if (uiServerStarted) {
      const api = await loadUiServerModule();
      api.stopTelegramUiServer();
    }
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }

  app.quit();
}

app.on("before-quit", () => {
  shuttingDown = true;
  // Unregister all custom global shortcuts before Electron's own cleanup.
  try { unregisterGlobalShortcuts(); } catch { /* ignore */ }
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  try {
    if (uiServerStarted && uiApi?.stopTelegramUiServer) {
      uiApi.stopTelegramUiServer();
    }
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }
});

app.on(
  "certificate-error",
  (event, _webContents, url, _error, _certificate, callback) => {
    try {
      const hostname = new URL(url).hostname;
      if ((uiOrigin && url.startsWith(uiOrigin)) || isLocalHost(hostname)) {
        event.preventDefault();
        callback(true);
        return;
      }
    } catch {
      // malformed URL — fall through
    }
    callback(false);
  },
);

app.on("window-all-closed", () => {
  // In tray mode the app intentionally keeps running with no open windows.
  // Only shut down when quitting explicitly (e.g. tray menu Quit or Cmd+Q).
  if (trayMode) return;
  void shutdown("window_all_closed");
});

app.on("activate", () => {
  // macOS: clicking the dock icon (re-)shows the app.
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createMainWindow();
  } else {
    setWindowVisible(mainWindow);
  }
});

app.on("second-instance", () => {
  if (followWindow && !followWindow.isDestroyed() && followWindow.isVisible()) {
    setWindowVisible(followWindow);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createMainWindow();
    return;
  }
  setWindowVisible(mainWindow);
});

process.on("SIGINT", () => {
  void shutdown("sigint");
});

process.on("SIGTERM", () => {
  void shutdown("sigterm");
});

// ── Pre-ready Chromium flags ──────────────────────────────────────────────────
// These MUST be set before app.isReady() — Chromium reads the command line at
// process startup and ignores changes made after the browser process launches.

// Allow HTTPS connections to localhost (127.0.0.1, ::1, "localhost") using
// self-signed certificates without triggering CertVerifyProcBuiltin errors or
// ssl_client_socket_impl handshake-failed spam.  This only suppresses cert
// errors for the loopback address; external HTTPS connections are unaffected.
app.commandLine.appendSwitch("allow-insecure-localhost");

app.whenReady().then(bootstrap);
