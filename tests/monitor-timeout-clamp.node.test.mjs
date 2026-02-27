import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

function extractFunction(name) {
  const signature = `function ${name}(`;
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = bodyStart; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function createHarness() {
  const warnings = [];
  const calls = [];
  const guarded = [];
  const context = {
    console: { warn: (msg) => warnings.push(String(msg)) },
    runGuarded: (reason, fn) => {
      guarded.push(reason);
      return fn();
    },
    setTimeout: (cb, ms) => {
      calls.push({ kind: "timeout", ms });
      cb();
      return Symbol("timeout");
    },
    setInterval: (cb, ms) => {
      calls.push({ kind: "interval", ms });
      cb();
      return Symbol("interval");
    },
    result: null,
  };
  const script = `${extractFunction("safeSetInterval")}
${extractFunction("safeSetTimeout")}
result = { safeSetInterval, safeSetTimeout };`;
  vm.createContext(context);
  new vm.Script(script).runInContext(context);
  return {
    warnings,
    calls,
    guarded,
    safeSetInterval: context.result.safeSetInterval,
    safeSetTimeout: context.result.safeSetTimeout,
  };
}

test("safe timer wrappers clamp invalid and oversized delays", () => {
  const h = createHarness();
  h.safeSetTimeout("bad", () => {}, "NaN");
  h.safeSetTimeout("overflow", () => {}, 9_999_999_999);
  h.safeSetInterval("zero", () => {}, 0);
  h.safeSetInterval("ok", () => {}, 2500);

  assert.deepEqual(
    h.calls.map((c) => c.ms),
    [1, 2_147_483_647, 1, 2500],
  );
  assert.deepEqual(h.guarded, [
    "timeout:bad",
    "timeout:overflow",
    "interval:zero",
    "interval:ok",
  ]);
  assert.ok(h.warnings.some((line) => line.includes("timeout:bad")));
  assert.ok(h.warnings.some((line) => line.includes("timeout:overflow")));
  assert.ok(h.warnings.some((line) => line.includes("interval:zero")));
});
