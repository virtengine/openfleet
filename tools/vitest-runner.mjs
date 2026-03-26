import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";

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

export function findPackageRoot({ startDir = process.cwd() } = {}) {
  let currentDir = resolve(startDir);
  while (currentDir) {
    if (existsSync(resolve(currentDir, "package.json"))) {
      return currentDir;
    }
    currentDir = getParentDir(currentDir);
  }
  return null;
}

function resolveCliPathArg(value, { startDir, packageRoot }) {
  if (!value || isAbsolute(value)) {
    return value;
  }
  const startPath = resolve(startDir, value);
  if (existsSync(startPath)) {
    return startPath;
  }
  if (!packageRoot) {
    return value;
  }
  const packagePath = resolve(packageRoot, value);
  if (existsSync(packagePath)) {
    return packagePath;
  }
  return value;
}

export function resolveVitestArgs(
  args = process.argv.slice(2),
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }) } = {},
) {
  const normalizedArgs = [...args];
  const filteredArgs = [];
  let skipNextReporterValue = false;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (skipNextReporterValue) {
      skipNextReporterValue = false;
      continue;
    }
    if ((arg === '--reporter' || arg === '-r') && normalizedArgs[index + 1] === 'basic') {
      skipNextReporterValue = true;
      continue;
    }
    if (arg === '--reporter=basic') {
      continue;
    }
    if ((arg === "--config" || arg === "-c") && typeof normalizedArgs[index + 1] === "string") {
      filteredArgs.push(arg);
      filteredArgs.push(resolveCliPathArg(normalizedArgs[index + 1], {
        startDir,
        packageRoot,
      }));
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      filteredArgs.push(`--config=${resolveCliPathArg(value, { startDir, packageRoot })}`);
      continue;
    }
    filteredArgs.push(arg);
  }
  return filteredArgs;
}

export function runVitest(args = process.argv.slice(2), { startDir = process.cwd() } = {}) {
  const vitestEntry = findVitestEntry({ startDir });
  if (!vitestEntry) {
    console.error(
      `Unable to locate vitest from ${startDir}. Run npm install in this repository root first.`,
    );
    return 1;
  }

  const vitestArgs = resolveVitestArgs(args, { startDir });

  const result = spawnSync(process.execPath, [vitestEntry, ...vitestArgs], {
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
