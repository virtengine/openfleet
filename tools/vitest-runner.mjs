import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

function getParentDir(dir) {
  const parent = dirname(dir);
  return parent === dir ? null : parent;
}

export function findVitestEntry({ startDir = process.cwd() } = {}) {
  let currentDir = resolve(startDir);
  while (currentDir) {
    const vitestEntry = resolve(currentDir, "node_modules", "vitest", "vitest.mjs");
    if (existsSync(vitestEntry)) {
      return vitestEntry;
    }
    currentDir = getParentDir(currentDir);
  }
  return null;
}

export function runVitest(args = process.argv.slice(2), { startDir = process.cwd() } = {}) {
  const vitestEntry = findVitestEntry({ startDir });
  if (!vitestEntry) {
    console.error(
      `Unable to locate vitest from ${startDir}. Run npm install in this repository root first.`,
    );
    return 1;
  }

  const result = spawnSync(process.execPath, [vitestEntry, ...args], {
    cwd: startDir,
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.error) {
    throw result.error;
  }
  return 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    process.exit(runVitest());
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
