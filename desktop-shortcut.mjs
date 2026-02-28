#!/usr/bin/env node

/**
 * bosun — Desktop Shortcut Manager
 *
 * Creates OS-native desktop launchers for the Bosun desktop portal.
 * - Windows: .lnk shortcut
 * - macOS:   .app bundle via osacompile (fallback: .command script)
 * - Linux:   .desktop entry
 */

import { spawnSync, execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Bosun";

function getPlatform() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unsupported";
  }
}

function getNodePath() {
  return process.execPath;
}

function getCliPath() {
  return resolve(__dirname, "cli.mjs");
}

function getDesktopMainPath() {
  return resolve(__dirname, "desktop", "main.mjs");
}

function getWorkingDirectory() {
  return __dirname;
}

/**
 * Attempt to locate the Electron binary that should be used to launch the
 * Bosun desktop app.
 *
 * Search order:
 *  1. BOSUN_ELECTRON_PATH env var — explicit override
 *  2. <bosun-dir>/node_modules/.bin/electron(.cmd)
 *  3. <bosun-dir>/../node_modules/.bin/electron(.cmd)  (repo root)
 *  4. electron(.cmd) anywhere on $PATH
 *
 * Returns the resolved absolute path to the electron binary, or null when
 * none could be located (falls back to node + cli.mjs --desktop).
 */
function findElectronBinary() {
  // 1. Explicit env override
  const envPath = process.env.BOSUN_ELECTRON_PATH;
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) return resolved;
  }

  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        resolve(__dirname, "node_modules", ".bin", "electron.cmd"),
        resolve(__dirname, "..", "node_modules", ".bin", "electron.cmd"),
        resolve(__dirname, "node_modules", ".bin", "electron.exe"),
        resolve(__dirname, "..", "node_modules", ".bin", "electron.exe"),
      ]
    : [
        resolve(__dirname, "node_modules", ".bin", "electron"),
        resolve(__dirname, "..", "node_modules", ".bin", "electron"),
      ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 4. Search $PATH
  try {
    const cmd = isWin ? "where electron.cmd 2>nul" : "which electron 2>/dev/null";
    const found = execSync(cmd, { encoding: "utf8", stdio: "pipe", timeout: 2000 })
      .trim()
      .split("\n")[0]
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not found on PATH */
  }

  return null;
}

/**
 * Return `{ executable, args }` for launching the Bosun desktop app.
 *
 * - If an Electron binary is found: launches `electron desktop/main.mjs`
 * - Otherwise: falls back to `node cli.mjs --desktop`
 */
function resolveElectronLauncher() {
  const electronPath = findElectronBinary();
  if (electronPath) {
    return { executable: electronPath, args: [getDesktopMainPath()] };
  }
  return { executable: getNodePath(), args: [getCliPath(), "--desktop"] };
}

/**
 * Build a quoted shell command string for the launcher.
 * Used by macOS .command fallback and Linux .desktop Exec= field.
 */
function buildShellCommand() {
  const { executable, args } = resolveElectronLauncher();
  const quotedArgs = args.map((a) => `"${a}"`).join(" ");
  return `"${executable}" ${quotedArgs}`;
}

function parseLinuxDesktopDir() {
  try {
    const configPath = resolve(homedir(), ".config", "user-dirs.dirs");
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, "utf8");
    const match = content.match(/^XDG_DESKTOP_DIR=(.*)$/m);
    if (!match) return null;
    const raw = match[1].trim().replace(/^"|"$/g, "");
    const expanded = raw
      .replace(/^\$HOME/, homedir())
      .replace(/^~(?=\/|$)/, homedir());
    return expanded ? resolve(expanded) : null;
  } catch {
    return null;
  }
}

function getDesktopDir() {
  const platform = getPlatform();
  if (platform === "windows") {
    const base = process.env.USERPROFILE || homedir();
    return resolve(base, "Desktop");
  }
  if (platform === "macos") {
    return resolve(homedir(), "Desktop");
  }
  if (platform === "linux") {
    return parseLinuxDesktopDir() || resolve(homedir(), "Desktop");
  }
  return null;
}

function ensureDesktopDir(dir) {
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function installWindowsShortcut(desktopDir) {
  const shortcutPath = resolve(desktopDir, `${APP_NAME}.lnk`);
  const { executable, args } = resolveElectronLauncher();
  const quotedArgs = args.map((a) => `"${a}"`).join(" ");
  const workingDir = getWorkingDirectory();
  const iconPath = resolve(__dirname, "logo.png");
  const iconLine = existsSync(iconPath)
    ? `$Shortcut.IconLocation = '${escapePowerShell(iconPath)}'`
    : "";
  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${escapePowerShell(shortcutPath)}')
$Shortcut.TargetPath = '${escapePowerShell(executable)}'
$Shortcut.Arguments = '${escapePowerShell(quotedArgs)}'
$Shortcut.WorkingDirectory = '${escapePowerShell(workingDir)}'
$Shortcut.Description = 'Bosun Desktop Portal'
${iconLine}
$Shortcut.Save()
`.trim();

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    { stdio: "pipe", windowsHide: true },
  );

  if (result.status !== 0) {
    const err = result.stderr?.toString() || result.error?.message || "";
    return { success: false, method: "Windows shortcut", error: err.trim() };
  }

  return {
    success: true,
    method: "Windows shortcut",
    path: shortcutPath,
    name: `${APP_NAME}.lnk`,
  };
}

function installMacShortcut(desktopDir) {
  const appPath = resolve(desktopDir, `${APP_NAME}.app`);
  const command = buildShellCommand();
  const script = `do shell script "${escapeAppleScript(command)}"`;

  const result = spawnSync("osacompile", ["-o", appPath, "-e", script], {
    stdio: "pipe",
  });

  if (result.status === 0 && existsSync(appPath)) {
    return {
      success: true,
      method: "macOS app",
      path: appPath,
      name: `${APP_NAME}.app`,
    };
  }

  const commandPath = resolve(desktopDir, `${APP_NAME}.command`);
  const scriptContent = `#!/bin/bash\ncd "${getWorkingDirectory()}"\n${command}\n`;
  try {
    writeFileSync(commandPath, scriptContent, "utf8");
    chmodSync(commandPath, 0o755);
    return {
      success: true,
      method: "macOS command",
      path: commandPath,
      name: `${APP_NAME}.command`,
    };
  } catch (err) {
    return {
      success: false,
      method: "macOS shortcut",
      error: err.message,
    };
  }
}

function installLinuxShortcut(desktopDir) {
  const desktopPath = resolve(desktopDir, `${APP_NAME}.desktop`);
  const appDir = resolve(homedir(), ".local", "share", "applications");
  const appPath = resolve(appDir, `${APP_NAME}.desktop`);
  const iconPath = resolve(__dirname, "logo.png");
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    "Comment=Bosun Desktop Portal",
    `Icon=${iconPath}`,
    `Exec=${buildShellCommand()}`,
    `Path=${getWorkingDirectory()}`,
    "Terminal=false",
    "StartupNotify=true",
    "Categories=Development;Utility;",
    "NoDisplay=false",
    "",
  ].join("\n");

  try {
    writeFileSync(desktopPath, content, "utf8");
    chmodSync(desktopPath, 0o755);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(appPath, content, "utf8");
    chmodSync(appPath, 0o755);

    try {
      execSync(`gio set "${desktopPath}" metadata::trusted true`, {
        stdio: "ignore",
      });
      execSync(`gio set "${appPath}" metadata::trusted true`, {
        stdio: "ignore",
      });
    } catch {
      /* best effort */
    }
    return {
      success: true,
      method: "Linux desktop entry",
      path: desktopPath,
      name: `${APP_NAME}.desktop`,
    };
  } catch (err) {
    return { success: false, method: "Linux desktop entry", error: err.message };
  }
}

function getShortcutPaths() {
  const desktopDir = getDesktopDir();
  if (!desktopDir) return { desktopDir: null, paths: [] };
  const platform = getPlatform();
  if (platform === "windows") {
    return {
      desktopDir,
      paths: [resolve(desktopDir, `${APP_NAME}.lnk`)],
    };
  }
  if (platform === "macos") {
    return {
      desktopDir,
      paths: [
        resolve(desktopDir, `${APP_NAME}.app`),
        resolve(desktopDir, `${APP_NAME}.command`),
      ],
    };
  }
  if (platform === "linux") {
    return {
      desktopDir,
      paths: [resolve(desktopDir, `${APP_NAME}.desktop`)],
    };
  }
  return { desktopDir, paths: [] };
}

export function installDesktopShortcut() {
  const platform = getPlatform();
  if (platform === "unsupported") {
    return { success: false, method: "unsupported", error: "Unsupported OS" };
  }

  const desktopDir = getDesktopDir();
  if (!desktopDir || !ensureDesktopDir(desktopDir)) {
    return { success: false, method: platform, error: "Desktop folder unavailable" };
  }

  if (platform === "windows") return installWindowsShortcut(desktopDir);
  if (platform === "macos") return installMacShortcut(desktopDir);
  if (platform === "linux") return installLinuxShortcut(desktopDir);
  return { success: false, method: platform, error: "Unsupported OS" };
}

export function removeDesktopShortcut() {
  const platform = getPlatform();
  const { paths } = getShortcutPaths();
  if (platform === "unsupported") {
    return { success: false, method: "unsupported", error: "Unsupported OS" };
  }
  if (!paths.length) {
    return { success: false, method: platform, error: "Desktop folder unavailable" };
  }

  const removed = [];
  const errors = [];
  for (const path of paths) {
    try {
      if (existsSync(path)) {
        if (path.endsWith(".app")) {
          rmSync(path, { recursive: true, force: true });
        } else {
          unlinkSync(path);
        }
        removed.push(path);
      }
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    return { success: false, method: platform, error: errors.join("; ") };
  }

  return {
    success: true,
    method: platform,
    removed,
  };
}

export function getDesktopShortcutStatus() {
  const platform = getPlatform();
  const { paths } = getShortcutPaths();
  const existing = paths.find((p) => existsSync(p));
  return {
    installed: Boolean(existing),
    method: platform,
    path: existing || paths[0],
  };
}

export function getDesktopShortcutMethodName() {
  const platform = getPlatform();
  if (platform === "windows") return "Windows shortcut";
  if (platform === "macos") return "macOS app shortcut";
  if (platform === "linux") return "Linux desktop entry";
  return "unsupported";
}
