import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const monitorPath = resolve(process.cwd(), "monitor.mjs");
const monitorSource = readFileSync(monitorPath, "utf8");

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Function not found: ${functionName}`);

  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Function body not found: ${functionName}`);

  let depth = 0;
  let stringQuote = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      stringQuote = ch;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Function braces did not close: ${functionName}`);
}

function compileFunction(source, functionName, deps = {}) {
  const fnSource = extractFunctionSource(source, functionName);
  const depNames = Object.keys(deps);
  const depValues = Object.values(deps);
  const factory = new Function(...depNames, `${fnSource}\nreturn ${functionName};`);
  return factory(...depValues);
}

test("shouldFailoverMonitorSdk flags no-sdk-available errors", () => {
  const shouldFailoverMonitorSdk = compileFunction(monitorSource, "shouldFailoverMonitorSdk");
  assert.equal(
    shouldFailoverMonitorSdk("No SDK available: all clients disabled"),
    true,
  );
});

test("shouldFailoverMonitorSdk flags cooldown errors", () => {
  const shouldFailoverMonitorSdk = compileFunction(monitorSource, "shouldFailoverMonitorSdk");
  assert.equal(shouldFailoverMonitorSdk("Cooling down: codex (120s)"), true);
});

test("shouldFailoverMonitorSdk remains case-insensitive", () => {
  const shouldFailoverMonitorSdk = compileFunction(monitorSource, "shouldFailoverMonitorSdk");
  assert.equal(shouldFailoverMonitorSdk("COOLING DOWN: COPILOT"), true);
  assert.equal(shouldFailoverMonitorSdk("NO SDK AVAILABLE"), true);
});

test("shouldFailoverMonitorSdk still catches existing retryable categories", () => {
  const shouldFailoverMonitorSdk = compileFunction(monitorSource, "shouldFailoverMonitorSdk");
  assert.equal(shouldFailoverMonitorSdk("429 too many requests"), true);
  assert.equal(shouldFailoverMonitorSdk("gateway timeout while running monitor"), true);
});

test("shouldFailoverMonitorSdk ignores empty and non-retryable messages", () => {
  const shouldFailoverMonitorSdk = compileFunction(monitorSource, "shouldFailoverMonitorSdk");
  assert.equal(shouldFailoverMonitorSdk(""), false);
  assert.equal(shouldFailoverMonitorSdk(undefined), false);
  assert.equal(shouldFailoverMonitorSdk("validation failed: missing task id"), false);
});

test("runMonitorMonitorCycle always launches monitor-monitor with cooldown bypass", () => {
  const runOnceStart = monitorSource.indexOf("const runOnce = async (sdk) => {");
  assert.ok(runOnceStart >= 0, "runOnce block should exist");

  const runOnceEnd = monitorSource.indexOf("const runLogDir =", runOnceStart);
  assert.ok(runOnceEnd > runOnceStart, "runOnce block should end before runLogDir");

  const runOnceBlock = monitorSource.slice(runOnceStart, runOnceEnd);
  assert.match(runOnceBlock, /taskKey:\s*"monitor-monitor"/);
  assert.match(runOnceBlock, /ignoreSdkCooldown:\s*true/);
});

test("runMonitorMonitorCycle retries with failover for retryable monitor errors", () => {
  const failoverBranch = monitorSource.match(
    /if \(!result\.success && shouldFailoverMonitorSdk\(result\.error\)\) \{[\s\S]*?result = await runOnce\(sdk\);[\s\S]*?\}/,
  );
  assert.ok(
    failoverBranch,
    "runMonitorMonitorCycle should rotate SDK and retry when shouldFailoverMonitorSdk returns true",
  );
});