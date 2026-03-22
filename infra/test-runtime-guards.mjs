import { createRequire, syncBuiltinESMExports } from "node:module";
import { assertSafeGitMutationInTests } from "./test-runtime.mjs";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

let installed = false;

function guardInvocation(command, args, options) {
  assertSafeGitMutationInTests({
    command,
    args,
    cwd: options?.cwd,
  });
}

export function installTestRuntimeGuards() {
  if (installed) return;
  installed = true;

  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;

  childProcess.exec = function guardedExec(command, options, callback) {
    const normalizedOptions =
      typeof options === "function" || options == null ? {} : options;
    guardInvocation(command, [], normalizedOptions);
    return originalExec.call(this, command, options, callback);
  };

  childProcess.execSync = function guardedExecSync(command, options) {
    guardInvocation(command, [], options || {});
    return originalExecSync.call(this, command, options);
  };

  childProcess.execFile = function guardedExecFile(file, args, options, callback) {
    const normalizedArgs = Array.isArray(args) ? args : [];
    const normalizedOptions =
      Array.isArray(args) ? (typeof options === "function" || options == null ? {} : options) : (typeof args === "function" || args == null ? {} : args);
    guardInvocation(file, normalizedArgs, normalizedOptions);
    return originalExecFile.call(this, file, args, options, callback);
  };

  childProcess.execFileSync = function guardedExecFileSync(file, args, options) {
    const normalizedArgs = Array.isArray(args) ? args : [];
    const normalizedOptions = Array.isArray(args) ? (options || {}) : (args || {});
    guardInvocation(file, normalizedArgs, normalizedOptions);
    return originalExecFileSync.call(this, file, args, options);
  };

  childProcess.spawn = function guardedSpawn(command, args, options) {
    const normalizedArgs = Array.isArray(args) ? args : [];
    const normalizedOptions = Array.isArray(args) ? (options || {}) : (args || {});
    guardInvocation(command, normalizedArgs, normalizedOptions);
    return originalSpawn.call(this, command, args, options);
  };

  childProcess.spawnSync = function guardedSpawnSync(command, args, options) {
    const normalizedArgs = Array.isArray(args) ? args : [];
    const normalizedOptions = Array.isArray(args) ? (options || {}) : (args || {});
    guardInvocation(command, normalizedArgs, normalizedOptions);
    return originalSpawnSync.call(this, command, args, options);
  };

  syncBuiltinESMExports();
}
