import { app, BrowserWindow, session } from "electron";
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
let shuttingDown = false;
let uiServerStarted = false;
let uiOrigin = null;
let uiApi = null;
let runtimeConfigLoaded = false;

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
  const rawPort = Number(process.env.TELEGRAM_UI_PORT || "0");
  if (!Number.isFinite(rawPort) || rawPort <= 0) return null;
  const tlsDisabled = parseBoolEnv(process.env.TELEGRAM_UI_TLS_DISABLE, false);
  const protocol = tlsDisabled ? "http" : "https";
  const host =
    process.env.TELEGRAM_UI_DESKTOP_HOST ||
    process.env.TELEGRAM_UI_HOST ||
    "127.0.0.1";
  return `${protocol}://${host}:${rawPort}`;
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.mjs"),
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const uiUrl = await buildUiUrl();
  await mainWindow.loadURL(uiUrl);
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
    await createMainWindow();
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
  void shutdown("window_all_closed");
});

app.on("activate", () => {
  if (!mainWindow) {
    void createMainWindow();
  }
});

process.on("SIGINT", () => {
  void shutdown("sigint");
});

process.on("SIGTERM", () => {
  void shutdown("sigterm");
});

app.whenReady().then(bootstrap);
