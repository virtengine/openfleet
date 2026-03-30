import Module, { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_FLAG = Symbol.for("bosun.viteWindowsRealpathShimInstalled");
const ESBUILD_PATCH_FLAG = Symbol.for("bosun.viteWindowsEsbuildSyncFallbackInstalled");
const requireResolve = createRequire(import.meta.url).resolve;
const requireModule = createRequire(import.meta.url);

function safeResolve(specifier) {
  try {
    return requireResolve(specifier);
  } catch {
    return "";
  }
}

let ESBUILD_NODE_ENTRY = "";
try {
  ESBUILD_NODE_ENTRY = requireResolve("esbuild/bin/esbuild");
} catch {
  ESBUILD_NODE_ENTRY = "";
}
const ESBUILD_MAIN_ENTRY = safeResolve("esbuild");
const ESBUILD_LIB_MAIN_ENTRY = safeResolve("esbuild/lib/main.js");
const ESBUILD_SHIM_SPECIFIERS = new Set(
  [
    "esbuild",
    "esbuild/lib/main.js",
    ESBUILD_MAIN_ENTRY,
    ESBUILD_LIB_MAIN_ENTRY,
    ESBUILD_MAIN_ENTRY ? pathToFileURL(ESBUILD_MAIN_ENTRY).href : "",
    ESBUILD_LIB_MAIN_ENTRY ? pathToFileURL(ESBUILD_LIB_MAIN_ENTRY).href : "",
  ].filter(Boolean),
);
const ESBUILD_CANDIDATES = new Set(
  [
    ESBUILD_NODE_ENTRY,
    safeResolve("esbuild/bin/esbuild.js"),
    safeResolve("esbuild/bin/esbuild.exe"),
  ]
    .filter(Boolean)
    .map((entry) => resolve(entry)),
);

function createNoopChildProcess(callback) {
  const child = new EventEmitter();
  child.pid = 0;
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  child.kill = () => false;
  child.unref = () => child;
  queueMicrotask(() => {
    callback?.(null, "", "");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

function normalizeSpawnArgs(file, args, options) {
  if (Array.isArray(args)) {
    return {
      args: [...args],
      options: options && typeof options === "object" ? { ...options } : options,
    };
  }
  if (args && typeof args === "object") {
    return {
      args: [],
      options: { ...args },
    };
  }
  return {
    args: [],
    options,
  };
}

function shouldRouteEsbuildThroughNode(file) {
  const command = String(file || "").trim();
  if (!command) return false;
  const resolved = resolve(command);
  if (ESBUILD_CANDIDATES.has(resolved)) return true;
  const leaf = basename(command).toLowerCase();
  return leaf === "esbuild" || leaf === "esbuild.exe" || leaf === "esbuild.cmd";
}

function markBlockedChildSpawnForTests() {
  if (process.platform !== "win32") return;
  try {
    const result = childProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const errorCode = result?.error?.code;
    process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED =
      errorCode === "EPERM" || errorCode === "EACCES" ? "1" : "0";
  } catch (error) {
    process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED =
      error?.code === "EPERM" || error?.code === "EACCES" ? "1" : "0";
  }
}

function installEsbuildSyncFallback() {
  if (process.platform !== "win32") return;
  if (Module[ESBUILD_PATCH_FLAG]) return;

  const originalLoad = Module._load;
  const wrapperCache = new WeakMap();

  function patchEsbuildApi(realEsbuild) {
    if (!realEsbuild || (typeof realEsbuild !== "object" && typeof realEsbuild !== "function")) {
      return realEsbuild;
    }
    if (typeof realEsbuild.transformSync === "function") {
      realEsbuild.transform = async function patchedTransform(input, options) {
        return realEsbuild.transformSync(input, options);
      };
    }
    if (typeof realEsbuild.formatMessagesSync === "function") {
      realEsbuild.formatMessages = async function patchedFormatMessages(messages, options) {
        return realEsbuild.formatMessagesSync(messages, options);
      };
    }
    if (typeof realEsbuild.analyzeMetafileSync === "function") {
      realEsbuild.analyzeMetafile = async function patchedAnalyzeMetafile(metafile, options) {
        return realEsbuild.analyzeMetafileSync(metafile, options);
      };
    }
    if (typeof realEsbuild.buildSync === "function") {
      realEsbuild.build = async function patchedBuild(options) {
        return realEsbuild.buildSync(options);
      };
    }
    return realEsbuild;
  }

  function getWrappedEsbuild(realEsbuild) {
    if (!realEsbuild || (typeof realEsbuild !== "object" && typeof realEsbuild !== "function")) {
      return realEsbuild;
    }
    const cached = wrapperCache.get(realEsbuild);
    if (cached) return cached;
    patchEsbuildApi(realEsbuild);
    const wrapped = new Proxy(realEsbuild, {
      get(target, prop, receiver) {
        if (prop === "transform" && typeof target.transformSync === "function") {
          return async function patchedTransform(input, options) {
            return target.transformSync(input, options);
          };
        }
        if (prop === "formatMessages" && typeof target.formatMessagesSync === "function") {
          return async function patchedFormatMessages(messages, options) {
            return target.formatMessagesSync(messages, options);
          };
        }
        if (prop === "analyzeMetafile" && typeof target.analyzeMetafileSync === "function") {
          return async function patchedAnalyzeMetafile(metafile, options) {
            return target.analyzeMetafileSync(metafile, options);
          };
        }
        if (prop === "build" && typeof target.buildSync === "function") {
          return async function patchedBuild(options) {
            return target.buildSync(options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    wrapperCache.set(realEsbuild, wrapped);
    return wrapped;
  }

  for (const entry of [ESBUILD_MAIN_ENTRY, ESBUILD_LIB_MAIN_ENTRY].filter(Boolean)) {
    try {
      patchEsbuildApi(requireModule(entry));
    } catch {
      // Ignore eager patch failures and rely on the load hook below.
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    const requestText = String(request || "").trim();
    if (requestText === "esbuild") {
      return getWrappedEsbuild(loaded);
    }
    try {
      const resolvedRequest = Module._resolveFilename(request, parent, isMain);
      if (resolvedRequest === ESBUILD_MAIN_ENTRY || resolvedRequest === ESBUILD_LIB_MAIN_ENTRY) {
        return getWrappedEsbuild(loaded);
      }
    } catch {
      // Ignore resolution failures and fall back to the original module.
    }
    return loaded;
  };

  Object.defineProperty(Module, ESBUILD_PATCH_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function installViteWindowsRealpathShim() {
  if (process.platform !== "win32") return;
  markBlockedChildSpawnForTests();
  if (childProcess[PATCH_FLAG]) return;
  const vitestEsbuildShimUrl = pathToFileURL(
    resolve(import.meta.dirname, "vitest-esbuild-shim.mjs"),
  ).href;

  const originalExec = childProcess.exec;
  const originalSpawn = childProcess.spawn;

  childProcess.exec = function patchedExec(command, options, callback) {
    const normalizedCommand = String(command || "").trim().toLowerCase();
    if (normalizedCommand === "net use") {
      if (typeof options === "function") {
        return createNoopChildProcess(options);
      }
      if (typeof callback === "function") {
        return createNoopChildProcess(callback);
      }
      return createNoopChildProcess();
    }
    return originalExec.call(this, command, options, callback);
  };

  childProcess.spawn = function patchedSpawn(file, args, options) {
    if (!shouldRouteEsbuildThroughNode(file) || !ESBUILD_NODE_ENTRY) {
      return originalSpawn.call(this, file, args, options);
    }
    const normalized = normalizeSpawnArgs(file, args, options);
    return originalSpawn.call(
      this,
      process.execPath,
      [ESBUILD_NODE_ENTRY, ...normalized.args],
      normalized.options,
    );
  };
  syncBuiltinESMExports();

  Object.defineProperty(childProcess, PATCH_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context?.parentURL === vitestEsbuildShimUrl) {
        return nextResolve(specifier, context);
      }
      if (ESBUILD_SHIM_SPECIFIERS.has(specifier)) {
        return {
          shortCircuit: true,
          url: vitestEsbuildShimUrl,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  installEsbuildSyncFallback();
  syncBuiltinESMExports();
}

installViteWindowsRealpathShim();
