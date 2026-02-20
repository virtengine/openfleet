#!/usr/bin/env node

/**
 * bosun — Desktop Shortcut Manager
 *
 * Creates OS-native desktop launchers for the Bosun desktop portal.
 * - Windows: .lnk shortcut
 * - macOS:   .app bundle via osacompile (fallback: .command script)
 * - Linux:   .desktop entry
 */

import { spawnSync } from "node:child_process";
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

function getWorkingDirectory() {
  return __dirname;
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

function buildShellCommand() {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  return `"${nodePath}" "${cliPath}" --desktop`;
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function installWindowsShortcut(desktopDir) {
  const shortcutPath = resolve(desktopDir, `${APP_NAME}.lnk`);
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const args = `"${cliPath}" --desktop`;
  const workingDir = getWorkingDirectory();
  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${escapePowerShell(shortcutPath)}')
$Shortcut.TargetPath = '${escapePowerShell(nodePath)}'
$Shortcut.Arguments = '${escapePowerShell(args)}'
$Shortcut.WorkingDirectory = '${escapePowerShell(workingDir)}'
$Shortcut.Description = 'Bosun Desktop Portal'
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
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    "Comment=Bosun Desktop Portal",
    `Exec=${buildShellCommand()}`,
    `Path=${getWorkingDirectory()}`,
    "Terminal=false",
    "StartupNotify=true",
    "Categories=Development;Utility;",
    "",
  ].join("\n");

  try {
    writeFileSync(desktopPath, content, "utf8");
    chmodSync(desktopPath, 0o755);
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
