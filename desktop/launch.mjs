import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname);
const binName = process.platform === "win32" ? "electron.cmd" : "electron";
const electronBin = resolve(desktopDir, "node_modules", ".bin", binName);
const electronWinExe = resolve(desktopDir, "node_modules", "electron", "dist", "electron.exe");
const chromeSandbox = resolve(
  desktopDir,
  "node_modules",
  "electron",
  "dist",
  "chrome-sandbox",
);

process.title = "bosun-desktop-launcher";

function isWslInteropRuntime() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function toWindowsPath(path) {
  if (!isWslInteropRuntime()) return path;
  try {
    return execFileSync("wslpath", ["-w", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return path;
  }
}

function hasGuiEnvironment() {
  if (process.platform !== "linux" || isWslInteropRuntime()) return true;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  if (process.env.XDG_SESSION_TYPE && process.env.XDG_SESSION_TYPE !== "tty") return true;
  return false;
}

function shouldDisableSandbox() {
  if (process.env.BOSUN_DESKTOP_DISABLE_SANDBOX === "1") return true;
  if (process.platform !== "linux") return false;
  if (!existsSync(chromeSandbox)) return true;
  try {
    const stats = statSync(chromeSandbox);
    const mode = stats.mode & 0o7777;
    const isRootOwned = stats.uid === 0;
    const isSetuid = mode === 0o4755;
    return !(isRootOwned && isSetuid);
  } catch {
    return true;
  }
}

function resolveDesktopConfigDir() {
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);
  const baseDir =
    process.env.APPDATA ||
    process.env.LOCALAPPDATA ||
    process.env.USERPROFILE ||
    process.env.HOME ||
    homedir();
  return resolve(baseDir, "bosun");
}

function readDesktopApiKeyFromDisk() {
  try {
    const file = resolve(resolveDesktopConfigDir(), "desktop-api-key.json");
    if (!existsSync(file)) return "";
    const payload = JSON.parse(readFileSync(file, "utf8"));
    const key = String(payload?.key || "").trim();
    if (!key.startsWith("bosun_desktop_")) return "";
    return key;
  } catch {
    return "";
  }
}

function ensureElectronInstalled() {
  if (existsSync(electronBin) || (isWslInteropRuntime() && existsSync(electronWinExe))) return true;
  if (process.env.BOSUN_DESKTOP_SKIP_INSTALL === "1") {
    console.error("[desktop] Electron not installed. Run: npm -C scripts/bosun/desktop install");
    return false;
  }
  console.log("[desktop] Installing Electron...");
  const result = spawnSync("npm", ["install"], {
    cwd: desktopDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  return result.status === 0 && existsSync(electronBin);
}

function buildElectronLaunchSpec(args) {
  if ((process.platform === "win32" || isWslInteropRuntime()) && existsSync(electronWinExe)) {
    return {
      command: electronWinExe,
      args: args.map((arg, idx) => (idx === 0 ? toWindowsPath(arg) : arg)),
      shell: false,
      cwd: desktopDir,
    };
  }
  return {
    command: electronBin,
    args,
    shell: process.platform === "win32",
    cwd: desktopDir,
  };
}

function launch() {
  if (!hasGuiEnvironment()) {
    console.error(
      [
        "[desktop] No GUI display server detected.",
        "Cannot launch Electron portal without DISPLAY/WAYLAND.",
        "Run Bosun in daemon/web mode instead (for example: `bosun --daemon`).",
      ].join(" "),
    );
    process.exit(1);
  }

  if (!ensureElectronInstalled()) {
    process.exit(1);
  }

  const disableSandbox = shouldDisableSandbox();
  const envDesktopApiKey = String(process.env.BOSUN_DESKTOP_API_KEY || "").trim();
  const diskDesktopApiKey = readDesktopApiKeyFromDisk();
  const desktopApiKey = diskDesktopApiKey || envDesktopApiKey;
  const args = [desktopDir];
  if (disableSandbox) {
    args.push("--no-sandbox", "--disable-gpu-sandbox");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const launchSpec = buildElectronLaunchSpec(args);

  const child = spawn(launchSpec.command, launchSpec.args, {
    stdio: "inherit",
    shell: launchSpec.shell,
    cwd: launchSpec.cwd,
    env: {
      ...env,
      BOSUN_DESKTOP: "1",
      ...(desktopApiKey ? { BOSUN_DESKTOP_API_KEY: desktopApiKey } : {}),
      ...(disableSandbox ? { ELECTRON_DISABLE_SANDBOX: "1" } : {}),
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }
    process.exit(code ?? 0);
  });
}

launch();
