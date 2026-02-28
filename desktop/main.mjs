import {
  app,
  BrowserWindow,
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
const FOLLOW_RESTORE_SHORTCUT = "CommandOrControl+Shift+V";

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
          accelerator: "CmdOrCtrl+N",
          click: () => navigateMainWindow("/"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
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
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => setWindowVisible(mainWindow),
        },
        {
          label: "Voice Companion",
          accelerator: FOLLOW_RESTORE_SHORTCUT,
          click: () => {
            if (!restoreFollowWindow()) setWindowVisible(mainWindow);
          },
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Dashboard",
          accelerator: "CmdOrCtrl+H",
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Agents",
          accelerator: "CmdOrCtrl+Shift+A",
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Tasks",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Logs",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => navigateMainWindow("/logs"),
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

async function ensureDaemonRunning() {
  const autoStart = parseBoolEnv(
    process.env.BOSUN_DESKTOP_AUTO_START_DAEMON,
    false,
  );
  if (!autoStart) return;

  const existing = getDaemonPid();
  if (existing) return;

  const ghosts = findGhostDaemonPids();
  if (ghosts.length > 0) return;

  const cliPath = resolveBosunRuntimePath("cli.mjs");
  if (!existsSync(cliPath)) {
    console.warn("[desktop] bosun CLI not found; daemon auto-start skipped");
    return;
  }

  try {
    const setupModule = await loadBosunModule("setup.mjs");
    if (setupModule?.shouldRunSetup?.()) {
      console.warn(
        "[desktop] setup required before daemon start; run: bosun --setup",
      );
      return;
    }
  } catch (err) {
    console.warn(
      "[desktop] unable to verify setup state; starting daemon anyway",
    );
  }

  const child = spawn(process.execPath, ["--run-as-node", cliPath, "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BOSUN_DESKTOP: "1" },
    cwd: resolveBosunRoot(),
    windowsHide: true,
  });
  child.unref();

  await waitForDaemon(4000);
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
    return daemonUrl;
  }
  await startUiServer();
  const api = await loadUiServerModule();
  const uiServerUrl = api.getTelegramUiUrl();
  if (!uiServerUrl) {
    throw new Error("Telegram UI server URL is unavailable.");
  }
  const targetUrl = new URL(uiServerUrl);
  uiOrigin = targetUrl.origin;
  const sessionToken = api.getSessionToken();
  if (sessionToken) {
    targetUrl.searchParams.set("token", sessionToken);
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
      preload: join(__dirname, "preload.mjs"),
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
      preload: join(__dirname, "preload.mjs"),
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
          accelerator: FOLLOW_RESTORE_SHORTCUT,
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

function registerShortcuts() {
  try {
    globalShortcut.register(FOLLOW_RESTORE_SHORTCUT, () => {
      if (!restoreFollowWindow()) setWindowVisible(mainWindow);
    });
  } catch (error) {
    console.warn("[desktop] failed to register shortcut", error?.message || error);
  }
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
}

async function bootstrap() {
  try {
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

    // Bypass TLS verification for the local embedded UI server.
    // setCertificateVerifyProc works at the OpenSSL level — it fires before
    // the higher-level `certificate-error` event and stops the repeated
    // "handshake failed" logs from Chromium's ssl_client_socket_impl.
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      if (isLocalHost(request.hostname)) {
        callback(0); // 0 = verified OK
        return;
      }
      callback(-3); // -3 = use Chromium default chain verification
    });

    await ensureDaemonRunning();
    Menu.setApplicationMenu(buildAppMenu());

    // Determine tray / background mode before creating any windows.
    trayMode = isTrayModeEnabled();
    // In tray mode the window starts hidden by default (background resident).
    // Set BOSUN_DESKTOP_START_HIDDEN=0 to open the window on every launch.
    startHidden = trayMode
      ? parseBoolEnv(process.env.BOSUN_DESKTOP_START_HIDDEN, true)
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

    registerShortcuts();
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

app.whenReady().then(bootstrap);
