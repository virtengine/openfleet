import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname);
const binName = process.platform === "win32" ? "electron.cmd" : "electron";
const electronBin = resolve(desktopDir, "node_modules", ".bin", binName);

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

  const child = spawn(electronBin, [desktopDir], {
    stdio: "inherit",
    env: {
      ...process.env,
      BOSUN_DESKTOP: "1",
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
