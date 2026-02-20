import { app, BrowserWindow } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let shuttingDown = false;
let uiServerStarted = false;
let uiOrigin = null;
let uiApi = null;

const DAEMON_PID_FILE = resolve(homedir(), ".cache", "bosun", "daemon.pid");

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
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

async function loadUiServerModule() {
  if (uiApi) return uiApi;
  uiApi = await loadBosunModule("ui-server.mjs");
  return uiApi;
}

async function ensureDaemonRunning() {
  const autoStart = parseBoolEnv(
    process.env.BOSUN_DESKTOP_AUTO_START_DAEMON,
    true,
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

  const child = spawn(process.execPath, [cliPath, "--daemon"], {
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
  const server = await api.startTelegramUiServer({});
  if (!server) {
    throw new Error("Failed to start Telegram UI server.");
  }
  uiServerStarted = true;
}

async function buildUiUrl() {
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

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
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
    app.setAppUserModelId("com.virtengine.bosun");
    process.chdir(resolveBosunRoot());
    await ensureDaemonRunning();
    await startUiServer();
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
    const api = await loadUiServerModule();
    api.stopTelegramUiServer();
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }

  app.quit();
}

app.on("before-quit", () => {
  shuttingDown = true;
  try {
    if (uiApi?.stopTelegramUiServer) {
      uiApi.stopTelegramUiServer();
    }
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }
});

app.on(
  "certificate-error",
  (event, _webContents, url, _error, _certificate, callback) => {
    if (uiOrigin && url.startsWith(uiOrigin)) {
      event.preventDefault();
      callback(true);
      return;
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
