import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname);
const binName = process.platform === "win32" ? "electron.cmd" : "electron";
const electronBin = resolve(desktopDir, "node_modules", ".bin", binName);
const chromeSandbox = resolve(
  desktopDir,
  "node_modules",
  "electron",
  "dist",
  "chrome-sandbox",
);

process.title = "bosun-desktop-launcher";

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

function ensureElectronInstalled() {
  if (existsSync(electronBin)) return true;
  if (process.env.BOSUN_DESKTOP_SKIP_INSTALL === "1") {
    console.error("[desktop] Electron not installed. Run: npm -C scripts/bosun/desktop install");
    return false;
  }
  console.log("[desktop] Installing Electron...");
  const result = spawnSync("npm", ["install"], {
    cwd: desktopDir,
    stdio: "inherit",
    env: process.env,
  });
  return result.status === 0 && existsSync(electronBin);
}

function launch() {
  if (!ensureElectronInstalled()) {
    process.exit(1);
  }

  const disableSandbox = shouldDisableSandbox();
  const args = [desktopDir];
  if (disableSandbox) {
    args.push("--no-sandbox", "--disable-gpu-sandbox");
  }

  const child = spawn(electronBin, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      BOSUN_DESKTOP: "1",
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
