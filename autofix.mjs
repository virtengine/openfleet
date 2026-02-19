/**
 * autofix.mjs — Self-healing engine for openfleet.
 *
 * Two operating modes determined by `isDevMode()`:
 *
 *   DEV MODE (running from source repo):
 *     - Actually applies fixes via `codex exec --full-auto`
 *     - Writes changes to disk, file watcher restarts orchestrator
 *
 *   NPM MODE (installed as npm package):
 *     - Analysis-only: diagnoses the issue and suggests fixes
 *     - Sends suggestions to Telegram / logs — never modifies files
 *     - User must apply suggested fixes manually
 *
 * Safety guardrails:
 *  - Max 3 attempts per unique error signature
 *  - 5-minute cooldown between fix attempts (prevents rapid crash loops)
 *  - Tracks all attempts for audit (autofix-*.log in log dir)
 *  - Won't retry the same error more than 3 times (gives up → Telegram alert)
 *  - Timeout guard on codex exec (30 min default, lets the agent finish its work)
 *
 * Error formats handled:
 *  - Standard PS errors: ErrorType: filepath:line:col
 *  - ParserError format: ParserError: filepath:line (no column)
 *  - Method invocation errors
 *  - Generic PS error blocks with "Line |" markers
 *  - Raw log fallback: when no structured errors found, feeds raw tail to Codex
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConsoleLevel, LogLevel } from "./lib/logger.mjs";
import { isBenignErrorMention } from "./utils.mjs";
import { resolvePromptTemplate } from "./agent-prompts.mjs";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Dev mode detection ──────────────────────────────────────────────────────

/**
 * Detect whether openfleet is running from its source repo (dev mode)
 * or from an npm install (npm mode).
 *
 * Dev mode indicators:
 *  - Running from a path that contains the source repo structure
 *  - The parent directory has go.mod, Makefile, etc. (monorepo root)
 *  - AUTOFIX_MODE env var is set to "execute" (explicit override)
 *
 * npm mode indicators:
 *  - Running from node_modules/
 *  - No monorepo markers in parent directories
 *  - AUTOFIX_MODE env var is set to "analyze" (explicit override)
 */
// ── Error extraction ────────────────────────────────────────────────────────

/**
 * Extract structured PowerShell errors from crash log text.
 * Uses a line-by-line parser for robustness (regex-only approaches break
 * on missing trailing newlines and backtracking edge cases).
 *
 * Handles: ParserError, RuntimeException, MethodInvocationException,
 * SetValueInvocationException, At-line stack traces, TerminatingError, etc.
 *
 * Returns [{ errorType, file, line, column?, message, signature, codeLine? }]
 */
export function extractErrors(logText) {
  const errors = [];
  const seen = new Set();

  function addError(err) {
    if (err && err.file && err.line && !seen.has(err.signature)) {
      seen.add(err.signature);
      errors.push(err);
    }
  }

  const lines = logText.split(/\r?\n/);

  // ── Line-by-line parser ───────────────────────────────────────────────

  // Pattern A: "ErrorType: filepath:line:col" or "ErrorType: filepath:line"
  // Followed by "Line |" block
  const errorHeaderWithCol =
    /^(\w[\w.-]+):\s+([A-Za-z]:\\[^\n:]+\.ps1):(\d+):(\d+)\s*$/;
  const errorHeaderNoCol =
    /^(\w[\w.-]*Error):\s+([A-Za-z]:\\[^\n:]+\.ps1):(\d+)\s*$/;

  // Pattern B: "At filepath:line char:col"
  const atLineHeader = /^At\s+([A-Za-z]:\\[^\n:]+\.ps1):(\d+)\s+char:(\d+)/;

  // Pattern C: TerminatingError(X): "message"
  const terminatingPattern = /TerminatingError\(([^)]+)\):\s*"(.+?)"/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Check Pattern A (with column) ───────────────────────────────
    let matchA = line.match(errorHeaderWithCol);
    if (matchA) {
      const parsed = parseLineBlock(lines, i + 1);
      addError({
        errorType: matchA[1],
        file: matchA[2],
        line: Number(matchA[3]),
        column: Number(matchA[4]),
        codeLine: parsed.codeLine,
        message: parsed.message,
        signature: `${matchA[2]}:${matchA[3]}:${matchA[1]}`,
      });
      continue;
    }

    // ── Check Pattern A (no column — ParserError, etc.) ─────────────
    let matchB = line.match(errorHeaderNoCol);
    if (matchB) {
      const parsed = parseLineBlock(lines, i + 1);
      addError({
        errorType: matchB[1],
        file: matchB[2],
        line: Number(matchB[3]),
        column: null,
        codeLine: parsed.codeLine,
        message: parsed.message,
        signature: `${matchB[2]}:${matchB[3]}:${matchB[1]}`,
      });
      continue;
    }

    // ── Check Pattern B (At line) ───────────────────────────────────
    let matchC = line.match(atLineHeader);
    if (matchC) {
      const parsed = parsePlusBlock(lines, i + 1);
      addError({
        errorType: parsed.errorType || "RuntimeException",
        file: matchC[1],
        line: Number(matchC[2]),
        column: Number(matchC[3]),
        codeLine: parsed.codeLine,
        message: parsed.message,
        signature: `${matchC[1]}:${matchC[2]}:${parsed.errorType || "RuntimeException"}`,
      });
      continue;
    }

    // ── Check Pattern C (TerminatingError) ──────────────────────────
    let matchD = line.match(terminatingPattern);
    if (matchD) {
      addError({
        errorType: "TerminatingError",
        file: "unknown",
        line: 0,
        column: null,
        message: `${matchD[1]}: ${matchD[2].trim()}`,
        signature: `TerminatingError:${matchD[1]}`,
      });
    }
  }

  return errors;
}

/**
 * Parse a "Line |" block starting at lineIdx.
 * Returns { codeLine, message }
 *
 * Example block:
 *   Line |
 *    123 |  $code = Something
 *        |          ~~~~~~
 *        | Error message here
 */
function parseLineBlock(lines, startIdx) {
  let codeLine = "";
  let message = "";

  let i = startIdx;

  // Skip "Line |" header
  if (i < lines.length && /^\s*Line\s*\|\s*$/.test(lines[i])) {
    i++;
  }

  // Capture code line: " NNN |  code..."
  if (i < lines.length && /^\s*\d+\s*\|/.test(lines[i])) {
    const codeMatch = lines[i].match(/^\s*\d+\s*\|\s*(.*)$/);
    if (codeMatch) codeLine = codeMatch[1].trim();
    i++;
  }

  // Skip underline and intermediate "| ..." lines, capture last "| message" line
  let lastPipeMessage = "";
  while (i < lines.length) {
    const pipeMatch = lines[i].match(/^\s*\|\s*(.*)$/);
    if (!pipeMatch) break;
    const content = pipeMatch[1].trim();
    // Skip underline-only lines (~~~~) and empty lines
    if (content && !/^~+$/.test(content)) {
      lastPipeMessage = content;
    }
    i++;
  }

  message = lastPipeMessage || codeLine;
  return { codeLine, message };
}

/**
 * Parse a "+ " block (from At-line stack traces) starting at lineIdx.
 * Returns { codeLine, message, errorType }
 *
 * Example block:
 *   + $result = Something
 *   +           ~~~~~~~~~~
 *   + ErrorType: explanation here
 */
function parsePlusBlock(lines, startIdx) {
  let codeLine = "";
  let message = "";
  let errorType = "";

  let i = startIdx;

  // First "+ " line is usually the code
  if (i < lines.length && /^\s*\+\s*/.test(lines[i])) {
    const codeMatch = lines[i].match(/^\s*\+\s*(.*)$/);
    if (codeMatch) {
      const content = codeMatch[1].trim();
      if (!/^~+$/.test(content)) codeLine = content;
    }
    i++;
  }

  // Subsequent "+ " lines — skip underlines, capture error type + message
  while (i < lines.length && /^\s*\+\s*/.test(lines[i])) {
    const plusMatch = lines[i].match(/^\s*\+\s*(.*)$/);
    if (plusMatch) {
      const content = plusMatch[1].trim();
      if (/^~+$/.test(content)) {
        i++;
        continue;
      }
      // Check for "ErrorType: message"
      const errMatch = content.match(/^(\w[\w.-]+):\s*(.+)$/);
      if (errMatch) {
        errorType = errMatch[1];
        message = errMatch[2].trim();
      }
    }
    i++;
  }

  return { codeLine, message, errorType };
}

/**
 * Extract a fallback "generic crash" descriptor when no structured errors found.
 * Pulls the last meaningful lines from the log for Codex to analyze.
 */
export function extractFallbackContext(logText, reason) {
  // Get the last 80 lines, filter out blanks and timestamp-only lines
  const lines = logText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-80).join("\n");

  // Try to detect the "last error-like" message
  const errorIndicators = [
    /error/i,
    /exception/i,
    /failed/i,
    /cannot /i,
    /unexpected/i,
    /invalid/i,
    /denied/i,
    /terminated/i,
  ];

  const errorLines = lines
    .slice(-40)
    .filter((l) => errorIndicators.some((re) => re.test(l)))
    .filter((l) => !isBenignErrorMention(l));

  return {
    tail,
    errorLines: errorLines.slice(-10),
    reason,
    lineCount: lines.length,
  };
}

// ── Source context reader ────────────────────────────────────────────────────

/**
 * Read source lines around the error for context.
 * Returns the source excerpt as a string with line numbers.
 */
async function readSourceContext(filePath, errorLine, contextLines = 30) {
  try {
    const source = await readFile(filePath, "utf8");
    const lines = source.split(/\r?\n/);
    const start = Math.max(0, errorLine - contextLines);
    const end = Math.min(lines.length, errorLine + contextLines);
    return lines
      .slice(start, end)
      .map((line, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === errorLine ? " >>>" : "    ";
        return `${marker}${String(lineNum).padStart(5)} | ${line}`;
      })
      .join("\n");
  } catch {
    return `(could not read ${filePath})`;
  }
}

// ── Fix tracking ────────────────────────────────────────────────────────────

// ── Dev mode detection ───────────────────────────────────────────────────────

/**
 * Detect whether openfleet is running from its source repo (dev mode)
 * or from an npm install (npm mode).
 *
 * Dev mode: AUTOFIX_MODE=dev/execute, or monorepo markers present
 * npm mode: AUTOFIX_MODE=npm/analyze/suggest, or inside node_modules
 */
let _devModeCache = null;

export function isDevMode() {
  if (_devModeCache !== null) return _devModeCache;

  const envMode = (process.env.AUTOFIX_MODE || "").toLowerCase();
  if (envMode === "execute" || envMode === "dev") {
    _devModeCache = true;
    return true;
  }
  if (envMode === "analyze" || envMode === "npm" || envMode === "suggest") {
    _devModeCache = false;
    return false;
  }

  // Check if we're inside node_modules (npm install)
  const normalized = __dirname.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/node_modules/")) {
    _devModeCache = false;
    return false;
  }

  // Check for monorepo markers (source repo)
  const repoRoot = resolve(__dirname, "..", "..");
  const monoRepoMarkers = ["go.mod", "Makefile", "AGENTS.md", "x"];
  const isMonoRepo = monoRepoMarkers.some((m) =>
    existsSync(resolve(repoRoot, m)),
  );

  _devModeCache = isMonoRepo;
  return isMonoRepo;
}

/** Reset dev mode cache (for testing). */
export function resetDevModeCache() {
  _devModeCache = null;
}

/** @type {Map<string, {count: number, lastAt: number}>} */
const fixAttempts = new Map();
const MAX_FIX_ATTEMPTS = 3;
// 1 min cooldown prevents rapid-fire crash loop while keeping retry cadence short.
const FIX_COOLDOWN_MS = 60_000;

function canAttemptFix(signature) {
  const record = fixAttempts.get(signature);
  if (!record) return true;
  if (record.count >= MAX_FIX_ATTEMPTS) return false;
  if (Date.now() - record.lastAt < FIX_COOLDOWN_MS) return false;
  return true;
}

function recordFixAttempt(signature) {
  const record = fixAttempts.get(signature) || { count: 0, lastAt: 0 };
  record.count += 1;
  record.lastAt = Date.now();
  fixAttempts.set(signature, record);
}

export function getFixAttemptCount(signature) {
  return fixAttempts.get(signature)?.count || 0;
}

// ── Codex exec runner ───────────────────────────────────────────────────────

/**
 * Run `codex exec --full-auto` with a fix prompt.
 * Returns { success, output, logPath } — Codex will write fixes directly to disk.
 *
 * Full Codex SDK streams are logged to logs/codex-sdk/ for debugging.
 *
 * Guards against common crash scenarios:
 *  - ENOENT: codex binary not found
 *  - Timeout: kills child after timeoutMs
 *  - Process spawn errors
 */
export function runCodexExec(
  prompt,
  cwd,
  timeoutMs = 1_800_000,
  logDir = null,
) {
  // Capture path.resolve before the Promise executor shadows it
  const pathResolve = resolve;
  return new Promise((promiseResolve) => {
    // ── Setup Codex SDK log directory ──────────────────────────────────
    const codexLogDir = logDir
      ? pathResolve(logDir, "codex-sdk")
      : pathResolve(__dirname, "logs", "codex-sdk");

    if (!existsSync(codexLogDir)) {
      mkdirSync(codexLogDir, { recursive: true });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = pathResolve(codexLogDir, `codex-exec-${stamp}.log`);

    let args;
    try {
      // Pass prompt via stdin (no positional arg) to avoid shell word-splitting
      args = [
        "exec",
        "--full-auto",
        "-a",
        "auto-edit",
        "--sandbox",
        "workspace-write",
        "-C",
        cwd,
      ];
    } catch (err) {
      return promiseResolve({
        success: false,
        output: "",
        error: `Failed to build args: ${err.message}`,
        logPath,
      });
    }

    let child;
    try {
      // Build a clean env for the codex CLI binary.
      // Auto-detect Azure: if OPENAI_BASE_URL contains .openai.azure.com,
      // configure the CLI for Azure via -c overrides and AZURE_OPENAI_API_KEY.
      // Otherwise strip OPENAI_BASE_URL so the CLI uses its ChatGPT OAuth.
      const { env: codexEnv } = resolveCodexProfileRuntime(process.env);
      const baseUrl = codexEnv.OPENAI_BASE_URL || "";
      const isAzure = baseUrl.includes(".openai.azure.com");
      if (isAzure) {
        // Map OPENAI_API_KEY → AZURE_OPENAI_API_KEY for Azure auth header
        if (codexEnv.OPENAI_API_KEY && !codexEnv.AZURE_OPENAI_API_KEY) {
          codexEnv.AZURE_OPENAI_API_KEY = codexEnv.OPENAI_API_KEY;
        }
        // Inject Azure provider config via -c overrides
        args.push(
          "-c", 'model_provider="azure"',
          "-c", 'model_providers.azure.name="Azure OpenAI"',
          "-c", `model_providers.azure.base_url="${baseUrl}"`,
          "-c", 'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"',
          "-c", 'model_providers.azure.wire_api="responses"',
        );
        // Override model from CODEX_MODEL env var — Azure deployment names
        // often differ from the config.toml model (e.g. "gpt-5.2-codex" vs
        // "gpt-5.3-codex"). The user sets the correct deployment name in .env.
        const azureModel = codexEnv.CODEX_MODEL;
        if (azureModel) {
          args.push("-m", azureModel);
        }
      }
      // Always strip OPENAI_BASE_URL — for Azure we use -c overrides above,
      // for non-Azure the CLI should use its built-in endpoint.
      delete codexEnv.OPENAI_BASE_URL;
      const spawnOptions = {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        // Do NOT set spawn timeout — we manage our own setTimeout to avoid
        // Node double-killing the child with SIGTERM before our handler runs.
        env: codexEnv,
      };
      if (process.platform === "win32") {
        // On Windows, avoid spawning via a shell with a concatenated command
        // string. Instead, invoke the binary directly with an argument array
        // just like on POSIX platforms to prevent command injection.
        child = spawn("codex", args, {
          ...spawnOptions,
          shell: false,
        });
      } else {
        child = spawn("codex", args, {
          ...spawnOptions,
          shell: false,
        });
      }
    } catch (err) {
      return promiseResolve({
        success: false,
        output: "",
        error: `spawn failed: ${err.message}`,
        logPath,
      });
    }

    // Write prompt to stdin then close the stream
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* stdin may already be closed */
    }

    let stdout = "";
    let stderr = "";
    const stream = createWriteStream(logPath, { flags: "w" });
    stream.write(
      [
        `# Codex SDK execution log`,
        `# Timestamp: ${new Date().toISOString()}`,
        `# Working directory: ${cwd}`,
        `# Command: codex ${args.join(" ")}`,
        `# Timeout: ${timeoutMs}ms`,
        ``,
        `## Prompt sent to Codex:`,
        prompt,
        ``,
        `## Codex SDK output stream:`,
        ``,
      ].join("\n"),
    );

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stream.write(text);
      // Only echo live agent output when --verbose or --trace is used
      if (getConsoleLevel() <= LogLevel.DEBUG) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stream.write(`[stderr] ${text}`);
      // Only echo live stderr when --verbose or --trace is used
      if (getConsoleLevel() <= LogLevel.DEBUG) process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      stream.write(`\n\n## TIMEOUT after ${timeoutMs}ms\n`);
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
      stream.end();
      promiseResolve({
        success: false,
        output: stdout,
        error: "timeout after " + timeoutMs + "ms",
        logPath,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      stream.write(`\n\n## ERROR: ${err.message}\n`);
      stream.end();
      promiseResolve({
        success: false,
        output: stdout,
        error: err.message,
        logPath,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      stream.write(`\n\n## Exit code: ${code}\n`);
      stream.write(`\n## stderr:\n${stderr}\n`);
      stream.end();
      promiseResolve({
        success: code === 0,
        output: stdout + (stderr ? "\n" + stderr : ""),
        error: code !== 0 ? `exit code ${code}` : null,
        logPath,
      });
    });
  });
}

// ── Main auto-fix function ──────────────────────────────────────────────────

/**
 * Detect which files were modified by comparing git status before/after.
 * Returns array of changed file paths.
 */
function detectChangedFiles(repoRoot) {
  try {
    const output = execSync("git diff --name-only", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    return output
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get git diff summary for changed files (short, for Telegram).
 */
function getChangeSummary(repoRoot, files) {
  if (!files.length) return "(no file changes detected)";
  try {
    const diff = execSync("git diff --stat", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    return diff.trim() || files.join(", ");
  } catch {
    return files.join(", ");
  }
}

/**
 * Attempt to auto-fix errors found in a crash log.
 *
 * In DEV MODE: extracts errors → runs codex exec → applies fixes to disk.
 * In NPM MODE: extracts errors → runs codex exec in read-only → sends
 *   suggested fix to Telegram/logs. Never modifies files.
 *
 * @param {object} opts
 * @param {string} opts.logText — tail of the crash log
 * @param {string} opts.reason — crash reason (signal/exit code)
 * @param {string} opts.repoRoot — repository root directory
 * @param {string} opts.logDir — directory for fix audit logs
 * @param {function} [opts.onTelegram] — optional callback to send Telegram message
 * @param {string[]} [opts.recentMessages] — recent Telegram messages for context
 * @param {object} [opts.promptTemplates] — optional prompt template overrides
 * @returns {Promise<{fixed: boolean, errors: object[], skipped: string[], outcome: string}>}
 */
export async function attemptAutoFix(opts) {
  const {
    logText,
    reason,
    repoRoot,
    logDir,
    onTelegram,
    recentMessages,
    promptTemplates = {},
  } = opts;

  const errors = extractErrors(logText);

  // ── Fallback: no structured errors → feed raw log to Codex ────────────
  if (errors.length === 0) {
    console.log(
      "[autofix] no structured errors found — trying raw log fallback",
    );

    const fallback = extractFallbackContext(logText, reason);

    // Don't attempt fallback on empty logs or clean exits
    if (
      fallback.lineCount < 3 &&
      !fallback.errorLines.length &&
      reason === "exit 0"
    ) {
      console.log("[autofix] clean exit with minimal log — skipping fallback");
      return {
        fixed: false,
        errors: [],
        skipped: [],
        outcome: "clean-exit-skip",
      };
    }

    const fallbackSig = `raw-fallback:${reason}`;
    if (!canAttemptFix(fallbackSig)) {
      const count = getFixAttemptCount(fallbackSig);
      console.warn(
        `[autofix] raw fallback exhausted (${count}/${MAX_FIX_ATTEMPTS})`,
      );
      if (onTelegram) {
        onTelegram(
          `🔧 Auto-fix gave up on raw crash (${reason}) after ${MAX_FIX_ATTEMPTS} attempts.\nManual intervention required.`,
        );
      }
      return {
        fixed: false,
        errors: [],
        skipped: [fallbackSig],
        outcome: "fallback-exhausted",
      };
    }

    recordFixAttempt(fallbackSig);
    const attemptNum = getFixAttemptCount(fallbackSig);
    const devMode = isDevMode();
    const modeLabel = devMode ? "execute" : "analyze-only";

    if (onTelegram) {
      onTelegram(
        `🔧 Auto-fix starting [${modeLabel}] (raw fallback, attempt #${attemptNum}):\nCrash: ${reason}\nError indicators: ${fallback.errorLines.length} suspicious lines`,
      );
    }

    const prompt = buildFallbackPrompt(
      fallback,
      recentMessages,
      promptTemplates.autofixFallback,
    );

    // Audit log
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const auditPath = resolve(
      logDir,
      `autofix-fallback-${stamp}-attempt${attemptNum}.log`,
    );
    await writeFile(
      auditPath,
      [
        `# Auto-fix FALLBACK attempt #${attemptNum} [${modeLabel}]`,
        `# Reason: ${reason}`,
        `# Error lines found: ${fallback.errorLines.length}`,
        `# Timestamp: ${new Date().toISOString()}`,
        "",
        "## Prompt sent to Codex:",
        prompt,
        "",
      ].join("\n"),
      "utf8",
    );

    // ── NPM mode: analyze only, suggest fix to user ──────────────────
    if (!devMode) {
      console.log("[autofix] npm mode — skipping execution, sending analysis");

      const suggestion =
        `📋 *Auto-fix analysis* (raw fallback, attempt #${attemptNum}):\n` +
        `Crash: ${reason}\n\n` +
        `**Error indicators found:**\n` +
        (fallback.errorLines.length > 0
          ? fallback.errorLines
              .slice(0, 10)
              .map((l) => `• ${l}`)
              .join("\n")
          : "(no explicit error lines — possible SIGKILL/OOM)") +
        `\n\n**Suggested action:** Review the error indicators above. ` +
        `The main orchestrator script is \`scripts/openfleet/ve-orchestrator.ps1\`. ` +
        `Check for PowerShell syntax errors, null references, or infinite retry loops.`;

      await writeFile(
        auditPath,
        [
          "",
          `## Mode: ANALYZE-ONLY (npm mode)`,
          `## Suggestion sent to user (no files modified)`,
          suggestion,
        ].join("\n"),
        { flag: "a" },
      );

      if (onTelegram) onTelegram(suggestion);

      return {
        fixed: false,
        errors: [],
        skipped: [],
        outcome: suggestion,
      };
    }

    // ── DEV mode: execute fix via Codex ──────────────────────────────
    const filesBefore = detectChangedFiles(repoRoot);
    const result = await runCodexExec(prompt, repoRoot, 1_800_000, logDir);
    const filesAfter = detectChangedFiles(repoRoot);

    // Detect new changes
    const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
    const changeSummary = getChangeSummary(repoRoot, newChanges);

    await writeFile(
      auditPath,
      [
        "",
        `## Mode: EXECUTE (dev mode)`,
        `## Codex SDK full log: ${result.logPath || "N/A"}`,
        `## Codex result (success=${result.success}):`,
        result.output || "(no output)",
        result.error ? `## Error: ${result.error}` : "",
        `## Files changed: ${newChanges.join(", ") || "none"}`,
      ].join("\n"),
      { flag: "a" },
    );

    if (result.success && newChanges.length > 0) {
      const outcomeMsg =
        `🔧 Auto-fix applied (raw fallback, attempt #${attemptNum}):\n` +
        `Crash: ${reason}\n` +
        `Changes:\n${changeSummary}\n` +
        `Codex SDK log: ${result.logPath}`;
      console.log(`[autofix] fallback fix applied: ${newChanges.join(", ")}`);
      console.log(`[autofix] Codex SDK full log: ${result.logPath}`);
      if (onTelegram) onTelegram(outcomeMsg);
      return {
        fixed: true,
        errors: [],
        skipped: [],
        outcome: outcomeMsg,
      };
    } else {
      const outcomeMsg =
        `🔧 Auto-fix fallback failed (attempt #${attemptNum}):\n` +
        `Crash: ${reason}\n` +
        `Codex: ${result.error || "no changes written"}\n` +
        `Codex SDK log: ${result.logPath}`;
      console.warn(`[autofix] fallback codex exec failed: ${result.error}`);
      console.log(`[autofix] Codex SDK full log: ${result.logPath}`);
      if (onTelegram) onTelegram(outcomeMsg);
      return {
        fixed: false,
        errors: [],
        skipped: [],
        outcome: outcomeMsg,
      };
    }
  }

  // ── Structured errors found ───────────────────────────────────────────
  console.log(`[autofix] found ${errors.length} error(s) in crash log`);

  const devMode = isDevMode();
  const modeLabel = devMode ? "execute" : "analyze-only";

  if (onTelegram) {
    const errorSummary = errors
      .map((e) => `• ${e.errorType}: ${e.file}:${e.line}`)
      .join("\n");
    onTelegram(
      `🔧 Auto-fix starting [${modeLabel}]:\nFound ${errors.length} error(s):\n${errorSummary}`,
    );
  }

  const skipped = [];
  let anyFixed = false;
  const outcomes = [];

  for (const error of errors) {
    // Dedup: skip if we've already tried this fix too many times
    if (!canAttemptFix(error.signature)) {
      const count = getFixAttemptCount(error.signature);
      console.warn(
        `[autofix] skipping ${error.signature} (${count}/${MAX_FIX_ATTEMPTS} attempts exhausted or cooldown)`,
      );
      skipped.push(error.signature);

      if (count >= MAX_FIX_ATTEMPTS && onTelegram) {
        onTelegram(
          `🔧 Auto-fix gave up on ${error.file}:${error.line} after ${MAX_FIX_ATTEMPTS} attempts.\n` +
            `Error: ${error.message}\nManual intervention required.`,
        );
      }
      continue;
    }

    recordFixAttempt(error.signature);
    const attemptNum = getFixAttemptCount(error.signature);

    console.log(
      `[autofix] attempting fix #${attemptNum} [${modeLabel}] for ${error.file}:${error.line} — ${error.errorType}`,
    );

    // Read source context around the error
    const sourceContext =
      error.file !== "unknown"
        ? await readSourceContext(error.file, error.line)
        : "(file unknown — error extracted from log)";

    // Build a focused fix prompt
    const prompt = buildFixPrompt(
      error,
      sourceContext,
      reason,
      recentMessages,
      promptTemplates.autofixFix,
    );

    // Write prompt to audit log
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const auditPath = resolve(
      logDir,
      `autofix-${stamp}-attempt${attemptNum}.log`,
    );
    await writeFile(
      auditPath,
      [
        `# Auto-fix attempt #${attemptNum} [${modeLabel}]`,
        `# Error: ${error.errorType} at ${error.file}:${error.line}`,
        `# Message: ${error.message}`,
        `# Reason: ${reason}`,
        `# Timestamp: ${new Date().toISOString()}`,
        "",
        "## Prompt sent to Codex:",
        prompt,
        "",
      ].join("\n"),
      "utf8",
    );

    // ── NPM mode: analyze only, suggest fix to user ──────────────────
    if (!devMode) {
      const suggestion =
        `📋 *Auto-fix analysis* (attempt #${attemptNum}):\n` +
        `**${error.errorType}** at \`${error.file}:${error.line}\`\n` +
        `Message: ${error.message}\n` +
        (error.codeLine ? `Failing code: \`${error.codeLine}\`\n` : "") +
        `\n**Source context:**\n\`\`\`\n${sourceContext.slice(0, 800)}\n\`\`\`\n` +
        `\n**Suggested fix:** Check line ${error.line} for the ${error.errorType}. ` +
        `Common causes: null references, array/object type mismatches, ` +
        `missing variable declarations, or scope issues.`;

      await writeFile(
        auditPath,
        [
          "",
          `## Mode: ANALYZE-ONLY (npm mode)`,
          `## Suggestion sent to user (no files modified)`,
          suggestion,
        ].join("\n"),
        { flag: "a" },
      );

      outcomes.push(suggestion);
      if (onTelegram) onTelegram(suggestion);
      continue;
    }

    // ── DEV mode: execute fix via Codex ──────────────────────────────

    // Snapshot files before
    const filesBefore = detectChangedFiles(repoRoot);

    // Run Codex
    const result = await runCodexExec(prompt, repoRoot);

    // Detect what changed
    const filesAfter = detectChangedFiles(repoRoot);
    const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
    const changeSummary = getChangeSummary(repoRoot, newChanges);

    // Append result to audit log
    await writeFile(
      auditPath,
      [
        "",
        `## Mode: EXECUTE (dev mode)`,
        `## Codex result (success=${result.success}):`,
        result.output || "(no output)",
        result.error ? `## Error: ${result.error}` : "",
        `## Files changed: ${newChanges.join(", ") || "none"}`,
      ].join("\n"),
      { flag: "a" },
    );

    if (result.success) {
      const outcomeMsg =
        `🔧 Auto-fix applied (attempt #${attemptNum}):\n` +
        `${error.errorType} at ${error.file}:${error.line}\n` +
        `"${error.message}"\n` +
        `Changes:\n${changeSummary}`;

      console.log(
        `[autofix] fix applied for ${error.file}:${error.line} — file watcher will restart orchestrator`,
      );
      anyFixed = true;
      outcomes.push(outcomeMsg);

      if (onTelegram) onTelegram(outcomeMsg);
    } else {
      const outcomeMsg =
        `🔧 Auto-fix failed (attempt #${attemptNum}):\n` +
        `${error.errorType} at ${error.file}:${error.line}\n` +
        `Codex: ${result.error || "no changes written"}`;

      console.warn(
        `[autofix] codex exec failed: ${result.error || "unknown error"}`,
      );
      outcomes.push(outcomeMsg);

      if (onTelegram) onTelegram(outcomeMsg);
    }
  }

  return {
    fixed: anyFixed,
    errors,
    skipped,
    outcome: outcomes.join("\n---\n"),
  };
}

// ── Prompt builders ─────────────────────────────────────────────────────────

function buildRecentMessagesContext(recentMessages) {
  if (!recentMessages || !recentMessages.length) return "";
  const msgs = recentMessages.slice(-15);
  return `
## Recent monitor notifications (for context — shows what led to this crash)
${msgs.map((m, i) => `[${i + 1}] ${m}`).join("\n")}
`;
}

function buildFixPrompt(
  error,
  sourceContext,
  reason,
  recentMessages,
  promptTemplate = "",
) {
  const messagesCtx = buildRecentMessagesContext(recentMessages);

  const fallback = `You are a PowerShell expert fixing a crash in a running orchestrator script.

## Error
Type: ${error.errorType}
File: ${error.file}
Line: ${error.line}${error.column ? `\nColumn: ${error.column}` : ""}
Message: ${error.message}${error.codeLine ? `\nFailing code: ${error.codeLine}` : ""}
Crash reason: ${reason}

## Source context around line ${error.line}
\`\`\`powershell
${sourceContext}
\`\`\`
${messagesCtx}
## Instructions
1. Read the file "${error.file}"
2. Identify the root cause of the error at line ${error.line}
3. Fix ONLY the bug — minimal change, don't refactor unrelated code
4. Common PowerShell pitfalls:
   - \`+=\` on arrays with single items fails — use [List[object]] or @() wrapping
   - \`$a + $b\` on PSObjects fails — iterate and add individually
   - Pipeline output can be a single object, not an array — always wrap with @()
   - \`$null.Method()\` crashes — add null guards
   - Named mutex with "Global\\\\" prefix fails on non-elevated Windows — use plain names
   - \`$Var:\` is treated as a scope-qualified variable — use \`\${Var}:\` to embed colon in string
   - ParserError: check for syntax issues like unclosed brackets, bad string interpolation
5. Write the fix to the file. Do NOT create new files or refactor other functions.
6. Keep all existing functionality intact.`;
  return resolvePromptTemplate(
    promptTemplate,
    {
      ERROR_TYPE: error.errorType,
      ERROR_FILE: error.file,
      ERROR_LINE: error.line,
      ERROR_COLUMN_LINE: error.column ? `Column: ${error.column}` : "",
      ERROR_MESSAGE: error.message,
      ERROR_CODE_LINE: error.codeLine ? `Failing code: ${error.codeLine}` : "",
      CRASH_REASON: reason,
      SOURCE_CONTEXT: sourceContext,
      RECENT_MESSAGES_CONTEXT: messagesCtx,
    },
    fallback,
  );
}

function buildFallbackPrompt(fallback, recentMessages, promptTemplate = "") {
  const messagesCtx = buildRecentMessagesContext(recentMessages);

  const defaultPrompt = `You are a PowerShell expert analyzing an orchestrator script crash.
No structured error was extracted — the process terminated with: ${fallback.reason}

## Error indicators from log tail
${fallback.errorLines.length > 0 ? fallback.errorLines.join("\n") : "(no explicit error lines detected — possible SIGKILL, OOM, or silent crash)"}

## Last ${Math.min(80, fallback.lineCount)} lines of crash log
\`\`\`
${fallback.tail}
\`\`\`
${messagesCtx}
## Instructions
1. Analyze the log for the root cause of the crash
2. The main orchestrator script is: scripts/openfleet/ve-orchestrator.ps1
3. If you can identify a fixable bug, apply a minimal fix to the file
4. Common crash causes:
   - PowerShell syntax errors (\$Var: treated as scope, missing brackets)
   - Array/object operation errors (+=, +, pipeline single-item issues)
   - Null reference errors on optional API responses
   - Infinite loops or stack overflow from recursive calls
   - Exit code 4294967295 = unsigned overflow from uncaught exception
5. If the crash is external (SIGKILL, OOM) with no code bug, do nothing
6. Write any fix directly to the file. Keep existing functionality intact.`;
  return resolvePromptTemplate(
    promptTemplate,
    {
      FALLBACK_REASON: fallback.reason,
      FALLBACK_ERROR_LINES:
        fallback.errorLines.length > 0
          ? fallback.errorLines.join("\n")
          : "(no explicit error lines detected — possible SIGKILL, OOM, or silent crash)",
      FALLBACK_LINE_COUNT: Math.min(80, fallback.lineCount),
      FALLBACK_TAIL: fallback.tail,
      RECENT_MESSAGES_CONTEXT: messagesCtx,
    },
    defaultPrompt,
  );
}

// ── Repeating error (loop) fixer ────────────────────────────────────────────

/**
 * Fix a looping/repeating error detected while the orchestrator is still running.
 * Unlike attemptAutoFix (which handles crashes), this runs proactively when the
 * monitor detects the same error line appearing repeatedly.
 *
 * In DEV MODE: applies fix via Codex exec.
 * In NPM MODE: analyzes and sends fix suggestion to user.
 *
 * @param {object} opts
 * @param {string} opts.errorLine — the repeating error line
 * @param {number} opts.repeatCount — how many times it has repeated
 * @param {string} opts.repoRoot — repository root
 * @param {string} opts.logDir — log directory
 * @param {function} [opts.onTelegram] — Telegram callback
 * @param {string[]} [opts.recentMessages] — recent Telegram messages for context
 * @param {string} [opts.promptTemplate] — optional loop-fix prompt template
 * @returns {Promise<{fixed: boolean, outcome: string}>}
 */
export async function fixLoopingError(opts) {
  const {
    errorLine,
    repeatCount,
    repoRoot,
    logDir,
    onTelegram,
    recentMessages,
    promptTemplate = "",
  } = opts;

  const signature = `loop:${errorLine.slice(0, 120)}`;

  if (!canAttemptFix(signature)) {
    const count = getFixAttemptCount(signature);
    const outcome = `🔁 Loop fix gave up on repeating error after ${count} attempts.\n"${errorLine.slice(0, 200)}"\nManual intervention required.`;
    console.warn(`[autofix] loop fix exhausted for: ${errorLine.slice(0, 80)}`);
    if (onTelegram) onTelegram(outcome);
    return { fixed: false, outcome };
  }

  recordFixAttempt(signature);
  const attemptNum = getFixAttemptCount(signature);
  const devMode = isDevMode();
  const modeLabel = devMode ? "execute" : "analyze-only";

  if (onTelegram) {
    onTelegram(
      `🔁 Repeating error detected [${modeLabel}] (${repeatCount}x, fix attempt #${attemptNum}):\n"${errorLine.slice(0, 200)}"`,
    );
  }

  const messagesCtx = buildRecentMessagesContext(recentMessages);

  const defaultPrompt = `You are a PowerShell expert fixing a loop bug in a running orchestrator script.

## Problem
The following error line is repeating ${repeatCount} times in the orchestrator output,
indicating an infinite retry loop that needs to be fixed:

"${errorLine}"

${messagesCtx}

## Instructions
1. The main script is: scripts/openfleet/ve-orchestrator.ps1
2. Search for the code that produces this error message
3. Identify why it loops (missing break/continue/return, no state change between iterations, etc.)
4. Fix the loop by adding proper exit conditions, error handling, or state tracking
5. Common loop-causing patterns in this codebase:
   - \`gh pr create\` failing with "No commits between" but caller retries every cycle
   - API calls returning the same error repeatedly with no backoff or give-up logic
   - Status not updated after failure → next cycle tries the same thing
   - Missing \`continue\` or state change in foreach loops over tracked attempts
6. Apply a minimal fix. Do NOT refactor unrelated code.
7. Write the fix directly to the file.`;
  const prompt = resolvePromptTemplate(
    promptTemplate,
    {
      REPEAT_COUNT: repeatCount,
      ERROR_LINE: errorLine,
      RECENT_MESSAGES_CONTEXT: messagesCtx,
    },
    defaultPrompt,
  );

  // Audit log
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const auditPath = resolve(
    logDir,
    `autofix-loop-${stamp}-attempt${attemptNum}.log`,
  );
  await writeFile(
    auditPath,
    [
      `# Loop fix attempt #${attemptNum} [${modeLabel}]`,
      `# Error line: ${errorLine}`,
      `# Repeat count: ${repeatCount}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Prompt sent to Codex:",
      prompt,
      "",
    ].join("\n"),
    "utf8",
  );

  // ── NPM mode: analyze only, suggest fix to user ──────────────────────
  if (!devMode) {
    console.log("[autofix] npm mode — loop fix: analysis only");

    const suggestion =
      `📋 *Loop fix analysis* (attempt #${attemptNum}):\n` +
      `**Repeating error** (${repeatCount}x):\n` +
      `\`${errorLine.slice(0, 300)}\`\n\n` +
      `**Likely cause:** This error is repeating in a loop, likely because:\n` +
      `• No break/continue/return after the error condition\n` +
      `• Status not updated after failure → retries the same operation\n` +
      `• Missing backoff or give-up logic after repeated failures\n\n` +
      `**Suggested fix:** Check \`scripts/openfleet/ve-orchestrator.ps1\` for the code ` +
      `that produces this error message and add proper exit conditions.`;

    await writeFile(
      auditPath,
      [
        "",
        `## Mode: ANALYZE-ONLY (npm mode)`,
        `## Suggestion sent to user (no files modified)`,
        suggestion,
      ].join("\n"),
      { flag: "a" },
    );

    if (onTelegram) onTelegram(suggestion);
    return { fixed: false, outcome: suggestion };
  }

  // ── DEV mode: execute fix via Codex ────────────────────────────────────
  const filesBefore = detectChangedFiles(repoRoot);
  const result = await runCodexExec(prompt, repoRoot);
  const filesAfter = detectChangedFiles(repoRoot);
  const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
  const changeSummary = getChangeSummary(repoRoot, newChanges);

  await writeFile(
    auditPath,
    [
      "",
      `## Mode: EXECUTE (dev mode)`,
      `## Codex result (success=${result.success}):`,
      result.output || "(no output)",
      result.error ? `## Error: ${result.error}` : "",
      `## Files changed: ${newChanges.join(", ") || "none"}`,
    ].join("\n"),
    { flag: "a" },
  );

  if (result.success && newChanges.length > 0) {
    const outcome =
      `🔁 Loop fix applied (attempt #${attemptNum}):\n` +
      `Error: "${errorLine.slice(0, 150)}"\n` +
      `Changes:\n${changeSummary}`;
    console.log(`[autofix] loop fix applied: ${newChanges.join(", ")}`);
    if (onTelegram) onTelegram(outcome);
    return { fixed: true, outcome };
  } else {
    const outcome =
      `🔁 Loop fix failed (attempt #${attemptNum}):\n` +
      `Error: "${errorLine.slice(0, 150)}"\n` +
      `Codex: ${result.error || "no changes written"}`;
    console.warn(`[autofix] loop fix codex exec failed: ${result.error}`);
    if (onTelegram) onTelegram(outcome);
    return { fixed: false, outcome };
  }
}
