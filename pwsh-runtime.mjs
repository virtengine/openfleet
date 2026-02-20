import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PWSH_PATH = resolve(__dirname, ".cache", "bosun", "pwsh", "pwsh");

function commandExists(cmd) {
  try {
    execSync(`${process.platform === "win32" ? "where" : "which"} ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isPathLike(value) {
  return value.includes("/") || value.includes("\\");
}

export function resolvePwshRuntime({ preferBundled = true } = {}) {
  const configured = String(process.env.PWSH_PATH || "").trim();
  if (configured) {
    if (isPathLike(configured)) {
      if (existsSync(configured)) {
        return { command: configured, source: "env", exists: true };
      }
      return { command: configured, source: "env", exists: false };
    }
    if (commandExists(configured)) {
      return { command: configured, source: "env", exists: true };
    }
    return { command: configured, source: "env", exists: false };
  }

  if (preferBundled && existsSync(BUNDLED_PWSH_PATH)) {
    return { command: BUNDLED_PWSH_PATH, source: "bundled", exists: true };
  }

  if (commandExists("pwsh")) {
    return { command: "pwsh", source: "path", exists: true };
  }

  if (process.platform === "win32" && commandExists("powershell")) {
    return { command: "powershell", source: "powershell", exists: true };
  }

  return { command: "pwsh", source: "missing", exists: false };
}

export function resolvePwshCommand(options = {}) {
  return resolvePwshRuntime(options).command;
}

export function hasPwshRuntime(options = {}) {
  return resolvePwshRuntime(options).exists;
}

export { BUNDLED_PWSH_PATH };
