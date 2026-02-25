import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

function extractFunction(functionName) {
  const signature = `function ${functionName}(`;
  const startIndex = cliSource.indexOf(signature);
  assert.notEqual(startIndex, -1, `missing function: ${functionName}`);

  const openBraceIndex = cliSource.indexOf("{", startIndex);
  assert.notEqual(openBraceIndex, -1, `missing opening brace: ${functionName}`);

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = openBraceIndex; i < cliSource.length; i += 1) {
    const ch = cliSource[i];

    if (inSingleQuote) {
      if (!escaped && ch === "'") inSingleQuote = false;
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (inDoubleQuote) {
      if (!escaped && ch === '"') inDoubleQuote = false;
      escaped = !escaped && ch === "\\";
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      escaped = false;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      escaped = false;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return cliSource.slice(startIndex, i + 1);
      }
    }
  }

  throw new Error(`unable to extract function: ${functionName}`);
}

function loadCliPidHelpers({ killImpl, existsSyncImpl, readFileSyncImpl }) {
  const scriptSource = [
    extractFunction("isProcessAlive"),
    extractFunction("readAlivePid"),
    "result = { isProcessAlive, readAlivePid };",
  ].join("\n\n");

  const context = {
    Number,
    JSON,
    existsSync: existsSyncImpl,
    readFileSync: readFileSyncImpl,
    process: {
      kill: killImpl,
    },
    result: null,
  };

  vm.createContext(context);
  new vm.Script(scriptSource).runInContext(context);
  return context.result;
}

function createFsMap(files) {
  return {
    existsSync(path) {
      return Object.prototype.hasOwnProperty.call(files, path);
    },
    readFileSync(path) {
      return files[path];
    },
  };
}

test("isProcessAlive returns false for invalid pid values without probing", () => {
  let killCalls = 0;
  const { isProcessAlive } = loadCliPidHelpers({
    killImpl() {
      killCalls += 1;
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => "",
  });

  assert.equal(isProcessAlive(Number.NaN), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-7), false);
  assert.equal(isProcessAlive(Number.POSITIVE_INFINITY), false);
  assert.equal(killCalls, 0);
});

test("isProcessAlive returns true when process.kill(pid, 0) succeeds", () => {
  const calls = [];
  const { isProcessAlive } = loadCliPidHelpers({
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => "",
  });

  assert.equal(isProcessAlive(4321), true);
  assert.deepEqual(calls, [[4321, 0]]);
});

test("isProcessAlive treats EPERM and EACCES as alive", () => {
  const { isProcessAlive: withEperm } = loadCliPidHelpers({
    killImpl() {
      const err = new Error("denied");
      err.code = "EPERM";
      throw err;
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => "",
  });

  const { isProcessAlive: withEacces } = loadCliPidHelpers({
    killImpl() {
      const err = new Error("denied");
      err.code = "EACCES";
      throw err;
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => "",
  });

  assert.equal(withEperm(2468), true);
  assert.equal(withEacces(2468), true);
});

test("isProcessAlive treats non-permission probe errors as dead", () => {
  const { isProcessAlive } = loadCliPidHelpers({
    killImpl() {
      const err = new Error("missing");
      err.code = "ESRCH";
      throw err;
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => "",
  });

  assert.equal(isProcessAlive(2468), false);
});

test("readAlivePid returns null when pid file does not exist", () => {
  const fsMap = createFsMap({});
  const { readAlivePid } = loadCliPidHelpers({
    killImpl() {
      throw new Error("should not be called");
    },
    existsSyncImpl: fsMap.existsSync,
    readFileSyncImpl: fsMap.readFileSync,
  });

  assert.equal(readAlivePid("missing.pid"), null);
});

test("readAlivePid accepts numeric pid files and permission-denied probes", () => {
  const fsMap = createFsMap({ "worker.pid": "1234\n" });
  const killCalls = [];
  const { readAlivePid } = loadCliPidHelpers({
    killImpl(pid, signal) {
      killCalls.push([pid, signal]);
      const err = new Error("denied");
      err.code = "EPERM";
      throw err;
    },
    existsSyncImpl: fsMap.existsSync,
    readFileSyncImpl: fsMap.readFileSync,
  });

  assert.equal(readAlivePid("worker.pid"), 1234);
  assert.deepEqual(killCalls, [[1234, 0]]);
});

test("readAlivePid accepts JSON pid files and EACCES probes", () => {
  const fsMap = createFsMap({ "worker.pid": '{"pid":5678}' });
  const { readAlivePid } = loadCliPidHelpers({
    killImpl() {
      const err = new Error("denied");
      err.code = "EACCES";
      throw err;
    },
    existsSyncImpl: fsMap.existsSync,
    readFileSyncImpl: fsMap.readFileSync,
  });

  assert.equal(readAlivePid("worker.pid"), 5678);
});

test("readAlivePid rejects malformed/invalid pid file content", () => {
  const malformedFsMap = createFsMap({ "worker.pid": "{not-json" });
  const emptyFsMap = createFsMap({ "empty.pid": "   " });
  const nonPositiveFsMap = createFsMap({ "zero.pid": "0" });

  const malformedHelpers = loadCliPidHelpers({
    killImpl() {
      throw new Error("should not probe malformed pid");
    },
    existsSyncImpl: malformedFsMap.existsSync,
    readFileSyncImpl: malformedFsMap.readFileSync,
  });

  const emptyHelpers = loadCliPidHelpers({
    killImpl() {
      throw new Error("should not probe empty pid");
    },
    existsSyncImpl: emptyFsMap.existsSync,
    readFileSyncImpl: emptyFsMap.readFileSync,
  });

  const nonPositiveHelpers = loadCliPidHelpers({
    killImpl() {
      throw new Error("should not probe zero pid");
    },
    existsSyncImpl: nonPositiveFsMap.existsSync,
    readFileSyncImpl: nonPositiveFsMap.readFileSync,
  });

  assert.equal(malformedHelpers.readAlivePid("worker.pid"), null);
  assert.equal(emptyHelpers.readAlivePid("empty.pid"), null);
  assert.equal(nonPositiveHelpers.readAlivePid("zero.pid"), null);
});

test("readAlivePid returns null when pid probe reports process missing", () => {
  const fsMap = createFsMap({ "worker.pid": "2222" });
  const { readAlivePid } = loadCliPidHelpers({
    killImpl() {
      const err = new Error("missing");
      err.code = "ESRCH";
      throw err;
    },
    existsSyncImpl: fsMap.existsSync,
    readFileSyncImpl: fsMap.readFileSync,
  });

  assert.equal(readAlivePid("worker.pid"), null);
});
