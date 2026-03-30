import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");
const monitorSource = readFileSync(
  resolve(process.cwd(), "infra/monitor.mjs"),
  "utf8",
);

function extractFunctionSource(source, functionName) {
  const asyncSignature = `async function ${functionName}(`;
  const syncSignature = `function ${functionName}(`;
  const start = source.indexOf(asyncSignature) >= 0
    ? source.indexOf(asyncSignature)
    : source.indexOf(syncSignature);
  if (start < 0) {
    throw new Error(`Function not found: ${functionName}`);
  }

  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) {
    throw new Error(`Function body not found: ${functionName}`);
  }

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
  const factory = new Function(
    ...depNames,
    `${fnSource}\nreturn ${functionName};`,
  );
  return factory(...depValues);
}

describe("cli restart request flow", () => {
  it("advertises --restart as a queued code reload control", () => {
    expect(cliSource).toContain(
      "--restart                   Request a code reload from the running bosun instance",
    );
    expect(cliSource).toContain('if (args.includes("--restart")) {');
    expect(cliSource).toContain('await requestRunningBosunRestart("cli-restart")');
    expect(cliSource).toContain(
      "The live instance will restart itself with fresh modules using its current launch path.",
    );
    expect(cliSource).toContain(
      "the reload stays queued until restart protection clears",
    );
  });

  it("writes restart requests beside the active monitor lock owner", async () => {
    const mkdirSync = vi.fn();
    const writeFileSync = vi.fn();
    const requestRunningBosunRestart = compileFunction(
      cliSource,
      "requestRunningBosunRestart",
      {
        getConfiguredRuntimeCacheDirs: async () => ["C:/repo/.cache", "C:/alt/.cache"],
        detectExistingMonitorLockOwner: () => ({
          pid: 4321,
          pidFile: "C:/repo/.cache/bosun.pid",
        }),
        getDaemonPid: () => null,
        getRestartRequestFileCandidates: (dirs) =>
          dirs.map((dir) => `${dir}/bosun-restart-request.json`),
        mkdirSync,
        writeFileSync,
        dirname: (filePath) => filePath.replace(/[/\\][^/\\]+$/, ""),
        process: {
          pid: 999,
          argv: ["node", "cli.mjs", "--restart"],
        },
        Date,
        JSON,
      },
    );

    const result = await requestRunningBosunRestart("cli-restart");

    expect(result.targetPid).toBe(4321);
    expect(result.requestPath).toBe("C:/repo/.cache/bosun-restart-request.json");
    expect(mkdirSync).toHaveBeenCalledWith("C:/repo/.cache", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [requestPath, payloadText, encoding] = writeFileSync.mock.calls[0];
    expect(requestPath).toBe("C:/repo/.cache/bosun-restart-request.json");
    expect(encoding).toBe("utf8");
    const payload = JSON.parse(payloadText);
    expect(payload.type).toBe("code-reload");
    expect(payload.reason).toBe("cli-restart");
    expect(payload.targetPid).toBe(4321);
    expect(payload.requesterPid).toBe(999);
    expect(payload.argv).toEqual(["cli.mjs", "--restart"]);
  });

  it("fails cleanly when no running bosun instance is found", async () => {
    const requestRunningBosunRestart = compileFunction(
      cliSource,
      "requestRunningBosunRestart",
      {
        getConfiguredRuntimeCacheDirs: async () => [],
        detectExistingMonitorLockOwner: () => null,
        getDaemonPid: () => null,
        getRestartRequestFileCandidates: () => [],
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        dirname: (filePath) => filePath.replace(/[/\\][^/\\]+$/, ""),
        process: {
          pid: 999,
          argv: ["node", "cli.mjs", "--restart"],
        },
        Date,
        JSON,
      },
    );

    await expect(requestRunningBosunRestart("cli-restart")).rejects.toThrow(
      "no running bosun instance found",
    );
  });
});

describe("monitor queued runtime restart flow", () => {
  it("polls a runtime restart request file and routes it into restartSelf", () => {
    expect(monitorSource).toContain("const runtimeRestartRequestPath = resolve(");
    expect(monitorSource).toContain('"bosun-restart-request.json"');
    expect(monitorSource).toContain('safeSetInterval("queued-runtime-restart-request", () => {');
    expect(monitorSource).toContain(
      'restartSelf(`queued-runtime-restart:${reason}`);',
    );
  });

  it("consumes matching restart requests and triggers guarded self-restart", () => {
    const unlinkSync = vi.fn();
    const restartSelf = vi.fn();
    const warn = vi.fn();
    const maybeHandleQueuedRuntimeRestartRequest = compileFunction(
      monitorSource,
      "maybeHandleQueuedRuntimeRestartRequest",
      {
        shuttingDown: false,
        existsSync: () => true,
        runtimeRestartRequestPath: "C:/repo/.cache/bosun-restart-request.json",
        readFileSync: () =>
          JSON.stringify({
            id: "req-1",
            type: "code-reload",
            reason: "cli-restart",
            requesterPid: 987,
            targetPid: 4321,
          }),
        unlinkSync,
        lastHandledRuntimeRestartRequestId: "",
        process: { pid: 4321 },
        restartSelf,
        console: { warn },
        Date,
        JSON,
      },
    );

    expect(maybeHandleQueuedRuntimeRestartRequest("interval")).toBe(true);
    expect(unlinkSync).toHaveBeenCalledWith(
      "C:/repo/.cache/bosun-restart-request.json",
    );
    expect(restartSelf).toHaveBeenCalledWith(
      "queued-runtime-restart:cli-restart",
    );
    expect(String(warn.mock.calls[0][0])).toContain(
      "queued runtime reload requested (cli-restart)",
    );
  });

  it("drops stale restart requests that target a different pid", () => {
    const unlinkSync = vi.fn();
    const restartSelf = vi.fn();
    const warn = vi.fn();
    const maybeHandleQueuedRuntimeRestartRequest = compileFunction(
      monitorSource,
      "maybeHandleQueuedRuntimeRestartRequest",
      {
        shuttingDown: false,
        existsSync: () => true,
        runtimeRestartRequestPath: "C:/repo/.cache/bosun-restart-request.json",
        readFileSync: () =>
          JSON.stringify({
            id: "req-2",
            type: "code-reload",
            reason: "cli-restart",
            targetPid: 1234,
          }),
        unlinkSync,
        lastHandledRuntimeRestartRequestId: "",
        process: { pid: 4321 },
        restartSelf,
        console: { warn },
        Date,
        JSON,
      },
    );

    expect(maybeHandleQueuedRuntimeRestartRequest("interval")).toBe(false);
    expect(unlinkSync).toHaveBeenCalledWith(
      "C:/repo/.cache/bosun-restart-request.json",
    );
    expect(restartSelf).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain(
      "ignoring runtime restart request for pid 1234",
    );
  });
});
