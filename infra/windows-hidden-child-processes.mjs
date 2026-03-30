import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

const PATCH_FLAG = Symbol.for("bosun.windowsHiddenChildProcessesInstalled");

function withHiddenWindow(options) {
  if (options == null || typeof options === "function") {
    return { windowsHide: true };
  }
  if (typeof options !== "object") {
    return options;
  }
  if (Object.prototype.hasOwnProperty.call(options, "windowsHide")) {
    return options;
  }
  return { ...options, windowsHide: true };
}

function installWindowsHiddenChildProcesses() {
  if (process.platform !== "win32") return;
  if (childProcess[PATCH_FLAG]) return;

  const original = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    exec: childProcess.exec,
    execFile: childProcess.execFile,
    execSync: childProcess.execSync,
    execFileSync: childProcess.execFileSync,
  };

  childProcess.spawn = function patchedSpawn(command, args, options) {
    if (Array.isArray(args)) {
      return original.spawn.call(this, command, args, withHiddenWindow(options));
    }
    return original.spawn.call(this, command, withHiddenWindow(args));
  };

  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    if (Array.isArray(args)) {
      return original.spawnSync.call(this, command, args, withHiddenWindow(options));
    }
    return original.spawnSync.call(this, command, withHiddenWindow(args));
  };

  childProcess.exec = function patchedExec(command, options, callback) {
    if (typeof options === "function") {
      return original.exec.call(this, command, withHiddenWindow(undefined), options);
    }
    if (typeof callback === "function") {
      return original.exec.call(this, command, withHiddenWindow(options), callback);
    }
    return original.exec.call(this, command, withHiddenWindow(options));
  };

  childProcess.execFile = function patchedExecFile(file, args, options, callback) {
    if (typeof args === "function") {
      return original.execFile.call(this, file, [], withHiddenWindow(undefined), args);
    }
    if (!Array.isArray(args)) {
      if (typeof options === "function") {
        return original.execFile.call(this, file, [], withHiddenWindow(args), options);
      }
      return original.execFile.call(this, file, [], withHiddenWindow(args), options);
    }
    if (typeof options === "function") {
      return original.execFile.call(this, file, args, withHiddenWindow(undefined), options);
    }
    if (typeof callback === "function") {
      return original.execFile.call(this, file, args, withHiddenWindow(options), callback);
    }
    return original.execFile.call(this, file, args, withHiddenWindow(options));
  };

  childProcess.execSync = function patchedExecSync(command, options) {
    return original.execSync.call(this, command, withHiddenWindow(options));
  };

  childProcess.execFileSync = function patchedExecFileSync(file, args, options) {
    if (Array.isArray(args)) {
      return original.execFileSync.call(this, file, args, withHiddenWindow(options));
    }
    return original.execFileSync.call(this, file, withHiddenWindow(args));
  };

  Object.defineProperty(childProcess, PATCH_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  syncBuiltinESMExports();
}

installWindowsHiddenChildProcesses();

export { installWindowsHiddenChildProcesses };
