import {
  app,
  BrowserWindow,
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
  if (process.platform === "win32") return [];
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
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Navigate the main window's SPA to the given path.
 * Falls back to a no-op if the window is not ready.
 */
function navigateMainWindow(path) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setWindowVisible(mainWindow);
  if (uiOrigin) {
    const safePath = JSON.stringify(path);
    mainWindow.webContents
      .executeJavaScript(
        `(function(){
          if (window.history && window.history.pushState) {
            window.history.pushState(null, '', ${safePath});
            window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
          }
        })()`,
      )
      .catch(() => {});
  }
}

/**
 * Build and return the application menu template.
 * This is called once during bootstrap and can be refreshed when
 * pack status or update state changes.
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
          click: () => navigateMainWindow("/"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Settings",
          accelerator: acc("app.settings"),
          click: () => navigateMainWindow("/settings"),
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
          label: "Dashboard",
          accelerator: acc("bosun.navigate.home"),
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Agents",
          accelerator: acc("bosun.navigate.agents"),
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Tasks",
          accelerator: acc("bosun.navigate.tasks"),
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Logs",
          accelerator: acc("bosun.navigate.logs"),
          click: () => navigateMainWindow("/logs"),
        },
        {
          label: "Settings",
          accelerator: acc("bosun.navigate.settings"),
          click: () => navigateMainWindow("/settings"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Quick New Chat",
          accelerator: acc("bosun.quickchat"),
          click: () => navigateMainWindow("/"),
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
 * Previously attempted to auto-start the bosun daemon from the Electron process.
 * This behaviour has been intentionally removed: the desktop MUST NOT launch bosun.
 *
 * If the daemon is offline, buildUiUrl() sets bosunDaemonWasOffline=true and
 * createMainWindow() injects an in-page banner with instructions on how to
 * start bosun manually or configure auto-start via `bosun --setup`.
 *
 * Kept as a no-op so bootstrap() need not change its call site.
 */
async function ensureDaemonRunning() {
  // Intentional no-op. Daemon auto-start from the desktop is permanently disabled.
  // Detection happens in buildUiUrl(); the offline banner is shown in createMainWindow().
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
  const iconPath = resolveBosunRuntimePath("logo.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
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
    // In tray mode, closing the window hides it to the tray instead of quitting.
    if (trayMode && !shuttingDown) {
      event.preventDefault();
      mainWindow?.hide();
      // On macOS, hide the dock icon when the window is hidden.
      if (process.platform === "darwin") {
        app.dock?.hide();
      }
      return;
    }
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

  const uiUrl = await buildUiUrl();
  await mainWindow.loadURL(uiUrl);

  // If the bosun daemon was not running when the desktop started, inject a
  // non-blocking banner so the user knows and has clear instructions.
  // The desktop NEVER auto-starts bosun — it is always a separate process.
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
              '\u26a0\ufe0f <strong>Bosun daemon is not running.</strong>',
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
  const iconPath = resolveBosunRuntimePath("logo.png");
  followWindow = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: "#0b0b0c",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
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

  const menu = Menu.buildFromTemplate([
    // ── Identity header ──────────────────────────────────────────────────
    {
      label: "VirtEngine",
      enabled: false,
    },
    {
      label: "Open",
      click: () => setWindowVisible(mainWindow),
    },
    { type: /** @type {const} */ ("separator") },

    // ── Launch Control ───────────────────────────────────────────────────
    {
      label: "Launch Control",
      submenu: [
        {
          label: "Dashboard",
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Agents",
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Tasks",
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Logs",
          click: () => navigateMainWindow("/logs"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Voice Companion",
          accelerator: acc("bosun.voice.toggle"),
          click: () => {
            if (!restoreFollowWindow()) setWindowVisible(mainWindow);
          },
        },
      ],
    },
    {
      label: "Restart to Apply Update",
      enabled: app.isPackaged,
      click: () => {
        app.relaunch();
        void shutdown("tray_restart_update");
      },
    },
    {
      label: "Preferences",
      accelerator: "CmdOrCtrl+,",
      click: () => navigateMainWindow("/settings"),
    },
    { type: /** @type {const} */ ("separator") },

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
          label: "Clear Cache & Reload",
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
    ...( app.isPackaged
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
  const iconPath = resolveBosunRuntimePath("logo.png");
  if (!existsSync(iconPath)) return;

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
    navigateMainWindow("/");
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
  onShortcut("bosun.navigate.agents", () => navigateMainWindow("/agents"));
  onShortcut("bosun.navigate.tasks", () => navigateMainWindow("/tasks"));
  onShortcut("bosun.navigate.logs", () => navigateMainWindow("/logs"));
  onShortcut("bosun.navigate.settings", () => navigateMainWindow("/settings"));
  onShortcut("app.newchat", () => navigateMainWindow("/"));
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

    if (process.env.ELECTRON_DISABLE_SANDBOX === "1") {
      app.commandLine.appendSwitch("no-sandbox");
      app.commandLine.appendSwitch("disable-gpu-sandbox");
    }
    app.setAppUserModelId("com.virtengine.bosun");
    const iconPath = resolveBosunRuntimePath("logo.png");
    if (existsSync(iconPath)) {
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

    await ensureDaemonRunning();

    // Initialise shortcuts (loads user config) and register globals.
    // Must happen before buildAppMenu() so acc() returns correct values.
    initAndRegisterShortcuts(resolveDesktopConfigDir());

    Menu.setApplicationMenu(buildAppMenu());

    // Determine tray / background mode before creating any windows.
    trayMode = isTrayModeEnabled();
    // In tray mode we still open the main window by default on startup.
    // Set BOSUN_DESKTOP_START_HIDDEN=1 to force background-only launch.
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
