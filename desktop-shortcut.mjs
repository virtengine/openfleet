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
  statSync,
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
    if (existsSync(resolved)) {
      return {
        path: resolved,
        kind: resolved.toLowerCase().endsWith(".cmd") ? "cmd" : "exe",
      };
    }
  }

  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        // Prefer real electron.exe first so shortcuts don't depend on "node"
        // being discoverable in PATH for cmd-shims.
        resolve(__dirname, "desktop", "node_modules", "electron", "dist", "electron.exe"),
        resolve(__dirname, "desktop", "node_modules", ".bin", "electron.exe"),
        resolve(__dirname, "desktop", "node_modules", ".bin", "electron.cmd"),
        resolve(__dirname, "node_modules", "electron", "dist", "electron.exe"),
        resolve(__dirname, "node_modules", ".bin", "electron.exe"),
        resolve(__dirname, "node_modules", ".bin", "electron.cmd"),
        resolve(__dirname, "node_modules", ".bin", "electron.exe"),
      ]
    : [
        resolve(__dirname, "desktop", "node_modules", ".bin", "electron"),
        resolve(__dirname, "node_modules", ".bin", "electron"),
      ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return {
        path: c,
        kind: c.toLowerCase().endsWith(".cmd") ? "cmd" : "exe",
      };
    }
  }

  // 4. Search $PATH
  try {
    const cmd = isWin
      ? "where electron.exe 2>nul || where electron.cmd 2>nul"
      : "which electron 2>/dev/null";
    const found = execSync(cmd, { encoding: "utf8", stdio: "pipe", timeout: 2000 })
      .trim()
      .split("\n")[0]
      .trim();
    if (found && existsSync(found)) {
      return {
        path: found,
        kind: found.toLowerCase().endsWith(".cmd") ? "cmd" : "exe",
      };
    }
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
export function resolveElectronLauncher() {
  const electron = findElectronBinary();
  if (electron) {
    // Windows .cmd launchers rely on PATH "node" lookup, which can fail when
    // started from a desktop shortcut. Route cmd-shims through process.execPath.
    if (process.platform === "win32" && electron.kind === "cmd") {
      const shimDir = dirname(electron.path);
      const electronCli = resolve(shimDir, "..", "electron", "cli.js");
      if (existsSync(electronCli)) {
        return { executable: getNodePath(), args: [electronCli, getDesktopMainPath()] };
      }
    }
    return { executable: electron.path, args: [getDesktopMainPath()] };
  }
  return { executable: getNodePath(), args: [getCliPath(), "--desktop"] };
}

function resolveLogoPngPath() {
  const candidates = [
    resolve(__dirname, "logo.png"),
    resolve(__dirname, "ui", "logo.png"),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function createIcoFromPng(pngBuffer) {
  if (pngBuffer.length < 24) {
    throw new Error("Invalid PNG file");
  }
  const pngSignature = "89504e470d0a1a0a";
  if (pngBuffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("Invalid PNG signature");
  }
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  const imageSize = pngBuffer.length;
  const headerSize = 6 + 16;
  const out = Buffer.alloc(headerSize + imageSize);

  // ICONDIR
  out.writeUInt16LE(0, 0); // reserved
  out.writeUInt16LE(1, 2); // type = icon
  out.writeUInt16LE(1, 4); // image count

  // ICONDIRENTRY
  out.writeUInt8(width >= 256 ? 0 : width, 6);
  out.writeUInt8(height >= 256 ? 0 : height, 7);
  out.writeUInt8(0, 8); // palette
  out.writeUInt8(0, 9); // reserved
  out.writeUInt16LE(1, 10); // color planes
  out.writeUInt16LE(32, 12); // bits per pixel
  out.writeUInt32LE(imageSize, 14); // image size
  out.writeUInt32LE(headerSize, 18); // image offset

  pngBuffer.copy(out, headerSize);
  return out;
}

function ensureWindowsShortcutIcon() {
  const pngPath = resolveLogoPngPath();
  if (!pngPath) return null;
  const cacheDir = resolve(homedir(), ".cache", "bosun", "icons");
  const icoPath = resolve(cacheDir, "bosun-shortcut.ico");
  try {
    mkdirSync(cacheDir, { recursive: true });
    const pngStat = statSync(pngPath);
    const needsRefresh = !existsSync(icoPath) || statSync(icoPath).mtimeMs < pngStat.mtimeMs;
    if (needsRefresh) {
      const pngBytes = readFileSync(pngPath);
      const icoBytes = createIcoFromPng(pngBytes);
      writeFileSync(icoPath, icoBytes);
    }
    return icoPath;
  } catch {
    return pngPath;
  }
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
  const iconPath = ensureWindowsShortcutIcon() || resolveLogoPngPath();
  const iconLine = iconPath && existsSync(iconPath)
    ? `$Shortcut.IconLocation = '${escapePowerShell(iconPath)},0'`
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
