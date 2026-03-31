import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function resolveWindowsEsbuildBinary({ startDir = process.cwd() } = {}) {
  if (process.platform !== "win32") return null;
  const packageRoot = findPackageRoot({ startDir });
  if (!packageRoot) return null;
  const candidates = [
    resolve(packageRoot, "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
    resolve(packageRoot, "node_modules", "@esbuild", "win32-ia32", "esbuild.exe"),
    resolve(packageRoot, "node_modules", "@esbuild", "win32-arm64", "esbuild.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
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

function detectChildSpawnBlocked() {
  try {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    return result?.error?.code === "EPERM";
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function resolveVitestHeapMb() {
  const explicit = Number.parseInt(String(process.env.BOSUN_VITEST_HEAP_MB || ""), 10);
  if (Number.isFinite(explicit) && explicit >= 2048) {
    return explicit;
  }
  return process.platform === "win32" ? 6144 : 4096;
}

function mergeNodeOptions(existingOptions, heapMb) {
  const existing = String(existingOptions || "").trim();
  const heapFlag = `--max-old-space-size=${heapMb}`;
  if (!existing) return heapFlag;
  const withoutHeap = existing
    .replace(/(?:^|\s)--max-old-space-size=\S+/g, " ")
    .replace(/(?:^|\s)--max_old_space_size=\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutHeap ? `${withoutHeap} ${heapFlag}` : heapFlag;
}

export function resolveVitestArgs(
  args = process.argv.slice(2),
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }) } = {},
) {
  const normalizedArgs = [...args];
  const filteredArgs = [];
  let hasConfigLoaderArg = false;
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
    if (arg === "--configLoader" || arg === "--config-loader") {
      hasConfigLoaderArg = true;
      filteredArgs.push(arg);
      if (typeof normalizedArgs[index + 1] === "string") {
        filteredArgs.push(normalizedArgs[index + 1]);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--configLoader=") || arg.startsWith("--config-loader=")) {
      hasConfigLoaderArg = true;
      filteredArgs.push(arg);
      continue;
    }
    filteredArgs.push(arg);
  }
  if (process.platform === "win32" && !hasConfigLoaderArg) {
    filteredArgs.push("--configLoader", "runner");
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
  const heapMb = resolveVitestHeapMb();
  const nodeArgs = [];
  if (process.platform === "win32") {
    const packageRoot = findPackageRoot({ startDir });
    const realpathShimPath = packageRoot
      ? resolve(packageRoot, "tools", "vite-windows-realpath-shim.mjs")
      : "";
    if (realpathShimPath && existsSync(realpathShimPath)) {
      nodeArgs.push("--import", pathToFileURL(realpathShimPath).href);
    }
  }
  nodeArgs.push("--no-warnings=ExperimentalWarning");
  nodeArgs.push(`--max-old-space-size=${heapMb}`);

  const esbuildBinaryPath = resolveWindowsEsbuildBinary({ startDir });
  const env = {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, heapMb),
    BOSUN_TEST_CHILD_SPAWN_BLOCKED: detectChildSpawnBlocked() ? "1" : "0",
    ...(esbuildBinaryPath && !process.env.ESBUILD_BINARY_PATH
      ? { ESBUILD_BINARY_PATH: esbuildBinaryPath }
      : {}),
  };

  const result = spawnSync(process.execPath, [...nodeArgs, vitestEntry, ...vitestArgs], {
    cwd: startDir,
    stdio: "inherit",
    env,
  });

  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.error) {
    throw result.error;
  }
  return 1;
}

export function isDirectExecution(argv = process.argv) {
  const scriptPath = argv?.[1];
  if (!scriptPath) return false;

  try {
    return fileURLToPath(import.meta.url) === resolve(scriptPath);
  } catch {
    try {
      return import.meta.url === pathToFileURL(resolve(scriptPath)).href;
    } catch {
      return false;
    }
  }
}

if (isDirectExecution()) {
  try {
    process.exit(runVitest());
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
