#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArgValue(flag) {
  const match = args.find((arg) => arg.startsWith(`${flag}=`));
  if (match) {
    return match.slice(flag.length + 1).trim();
  }
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return "";
}

function commandExists(command, probeArgs = ["--version"]) {
  try {
    execFileSync(command, probeArgs, { stdio: "ignore" });
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    return true;
  }
}

function resolveElectronCommand() {
  const envPath =
    process.env.BOSUN_ELECTRON_PATH || process.env.ELECTRON_PATH || "";
  if (envPath && existsSync(envPath)) {
    return { cmd: envPath, args: [] };
  }

  const binNames = process.platform === "win32"
    ? ["electron.cmd", "electron"]
    : ["electron"];
  const candidateRoots = [
    resolve(__dirname, "..", "node_modules", ".bin"),
    resolve(__dirname, "..", "..", "node_modules", ".bin"),
    resolve(process.cwd(), "node_modules", ".bin"),
  ];

  for (const root of candidateRoots) {
    for (const name of binNames) {
      const candidate = resolve(root, name);
      if (existsSync(candidate)) {
        return { cmd: candidate, args: [] };
      }
    }
  }

  if (commandExists("electron")) {
    return { cmd: "electron", args: [] };
  }

  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  if (commandExists(npxCmd, ["--version"])) {
    return { cmd: npxCmd, args: ["--yes", "electron"] };
  }

  return null;
}

const portalUrl =
  getArgValue("--url") ||
  process.env.BOSUN_PORTAL_URL ||
  process.env.PORTAL_URL ||
  "http://localhost:3000";
const portalTitle =
  getArgValue("--title") ||
  process.env.BOSUN_PORTAL_TITLE ||
  "VirtEngine Portal";
const openDevtools =
  args.includes("--devtools") || process.env.BOSUN_PORTAL_DEVTOOLS === "1";

const appDir = mkdtempSync(join(os.tmpdir(), "bosun-desktop-"));
const packageJson = {
  name: "bosun-desktop-portal",
  private: true,
  type: "module",
  main: "main.mjs",
};

writeFileSync(
  join(appDir, "package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
);

const mainSource = `import { app, BrowserWindow, shell } from "electron";

const portalUrl = process.env.BOSUN_PORTAL_URL || "http://localhost:3000";
const portalTitle = process.env.BOSUN_PORTAL_TITLE || "VirtEngine Portal";
const openDevtools = process.env.BOSUN_PORTAL_DEVTOOLS === "1";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0f19",
    title: portalTitle,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(portalUrl);
  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (openDevtools) {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
`;

writeFileSync(join(appDir, "main.mjs"), mainSource);

const electronCommand = resolveElectronCommand();
if (!electronCommand) {
  console.error(
    "\n  Error: Electron not found. Install Electron or set BOSUN_ELECTRON_PATH.\n",
  );
  process.exit(1);
}

const child = spawn(
  electronCommand.cmd,
  [...electronCommand.args, appDir],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      BOSUN_PORTAL_URL: portalUrl,
      BOSUN_PORTAL_TITLE: portalTitle,
      BOSUN_PORTAL_DEVTOOLS: openDevtools ? "1" : "0",
    },
  },
);

const cleanup = () => {
  try {
    rmSync(appDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
};

child.on("exit", (code, signal) => {
  cleanup();
  const exitCode = code ?? (signal ? 1 : 0);
  process.exit(exitCode);
});

child.on("error", (err) => {
  cleanup();
  console.error(`\n  Error: Failed to launch Electron: ${err.message}\n`);
  process.exit(1);
});
