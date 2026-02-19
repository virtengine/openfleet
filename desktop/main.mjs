import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSessionToken,
  getTelegramUiUrl,
  startTelegramUiServer,
  stopTelegramUiServer,
} from "../ui-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let shuttingDown = false;
let uiServerStarted = false;
let uiOrigin = null;

async function startUiServer() {
  if (uiServerStarted) return;
  const server = await startTelegramUiServer({});
  if (!server) {
    throw new Error("Failed to start Telegram UI server.");
  }
  uiServerStarted = true;
}

function buildUiUrl() {
  const uiServerUrl = getTelegramUiUrl();
  if (!uiServerUrl) {
    throw new Error("Telegram UI server URL is unavailable.");
  }
  const targetUrl = new URL(uiServerUrl);
  uiOrigin = targetUrl.origin;
  const sessionToken = getSessionToken();
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

  const uiUrl = buildUiUrl();
  await mainWindow.loadURL(uiUrl);
}

async function bootstrap() {
  try {
    await startUiServer();
    await createMainWindow();
  } catch (error) {
    console.error("[desktop] startup failed", error);
    await shutdown("startup_failed");
  }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (reason) {
    console.log(`[desktop] shutting down (${reason})`);
  }

  try {
    stopTelegramUiServer();
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }

  app.quit();
}

app.on("before-quit", () => {
  shuttingDown = true;
  try {
    stopTelegramUiServer();
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
