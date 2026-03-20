import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_FILE = process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE
  ? resolve(process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE)
  : resolve(__dirname, "..", ".cache", "command-diagnostics", "state.json");
const CACHE_DIR = dirname(STATE_FILE);
const MAX_STATE_RECORDS = 120;
const FILE_REF_REGEX = /((?:[A-Za-z]:)?[.~/\\\w-]+(?:[\\/][^:\s]+)+(?::\d+(?::\d+)?)?)/g;

let _fsPromises = null;
let _stateCache = null;

async function getFs() {
  if (!_fsPromises) {
    _fsPromises = await import("node:fs/promises");
  }
  return _fsPromises;
}

async function ensureCacheDir() {
  const fs = await getFs();
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function loadState() {
  if (_stateCache) return _stateCache;
  const fs = await getFs();
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    _stateCache = parsed && typeof parsed === "object" ? parsed : { records: {} };
  } catch {
    _stateCache = { records: {} };
  }
  if (!_stateCache.records || typeof _stateCache.records !== "object") {
    _stateCache.records = {};
  }
  return _stateCache;
}

async function saveState(state) {
  const fs = await getFs();
  await ensureCacheDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function quoteArg(value) {
  const raw = String(value || "");
  if (!raw) return '""';
  if (!/[\s"'|&()]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '\\"')}"`;
}

function normalizeCommandSignature(command = "", args = []) {
  const commandLine = collapseWhitespace(
    [String(command || "").trim(), ...(Array.isArray(args) ? args.map((value) => String(value || "").trim()) : [])]
      .filter(Boolean)
      .join(" "),
  );
  return commandLine.toLowerCase();
}

function resolveCommandKind(commandLine = "", output = "") {
  const lower = `${commandLine}\n${output}`.toLowerCase();
  if (/\bdotnet\s+test\b/.test(lower)) return { family: "test", runner: "dotnet-test" };
  if (/\b(?:python(?:3)?\s+-m\s+pytest|pytest)\b/.test(lower)) return { family: "test", runner: "pytest" };
  if (/\bvitest\b/.test(lower)) return { family: "test", runner: "vitest" };
  if (/\bjest\b/.test(lower)) return { family: "test", runner: "jest" };
  if (/\bgo\s+test\b/.test(lower)) return { family: "test", runner: "go-test" };
  if (/^\s*fail\s+.+\.(test|spec)\.[a-z0-9]+/im.test(output) || /test files\s+\d+\s+failed/i.test(output)) {
    return { family: "test", runner: "vitest" };
  }
  if (/^failed\s+.+::.+\s+-/im.test(output) || /collected \d+ items/i.test(output)) {
    return { family: "test", runner: "pytest" };
  }
  if (/\bgit\s+diff\b/.test(lower)) return { family: "git", runner: "git-diff" };
  if (/\bgit\s+status\b/.test(lower)) return { family: "git", runner: "git-status" };
  if (/\bgit\s+(show|log|grep|rebase|merge|pull|push)\b/.test(lower)) return { family: "git", runner: "git" };
  if (/\b(test|build|compile|lint|typecheck|msbuild|tsc|cargo|mvn|gradle)\b/.test(lower)) return { family: "build", runner: "build" };
  return { family: "generic", runner: "generic" };
}

function countRegex(text, regex) {
  const matches = String(text || "").match(regex);
  return Array.isArray(matches) ? matches.length : 0;
}

function extractFileRefs(text = "", limit = 10) {
  const refs = [];
  for (const match of String(text || "").matchAll(FILE_REF_REGEX)) {
    refs.push(match[1]);
    if (refs.length >= limit) break;
  }
  return uniqueValues(refs);
}

function parseDotnetTest(text) {
  const failedTargets = [];
  for (const match of String(text).matchAll(/^Failed\s+([A-Za-z0-9_.`]+)\s+\[[^\]]+\]/gm)) {
    failedTargets.push(match[1]);
  }
  const summaryMatch = text.match(/Failed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i);
  const summary = summaryMatch
    ? `${summaryMatch[1]} failed, ${summaryMatch[2]} passed, ${summaryMatch[3]} skipped (${summaryMatch[4]} total)`
    : failedTargets.length
      ? `${failedTargets.length} failing .NET test${failedTargets.length === 1 ? "" : "s"}`
      : "";
  return {
    failedTargets: uniqueValues(failedTargets),
    summary,
    rerunCommand: failedTargets.length
      ? `dotnet test --filter ${quoteArg(failedTargets.map((target) => `FullyQualifiedName~${target}`).join("|"))}`
      : null,
  };
}

function parsePytest(text) {
  const failedTargets = [];
  for (const match of String(text).matchAll(/^FAILED\s+(.+?)\s+-/gm)) {
    failedTargets.push(match[1]);
  }
  const failedCountMatch = text.match(/(^|[ =])(\d+)\s+failed\b/i);
  const failedCount = failedCountMatch ? Number(failedCountMatch[2]) : failedTargets.length;
  const summary = failedCount ? `${failedCount} failed pytest target${failedCount === 1 ? "" : "s"}` : "";
  return {
    failedTargets: uniqueValues(failedTargets),
    summary,
    rerunCommand: failedTargets.length
      ? `pytest ${failedTargets.slice(0, 8).map(quoteArg).join(" ")}`
      : null,
  };
}

function parseVitestLike(text, runner = "vitest") {
  const failedTargets = [];
  for (const match of String(text).matchAll(/^\s*FAIL\s+(.+)$/gm)) {
    failedTargets.push(match[1].trim());
  }
  const fileRefs = extractFileRefs(text, 12).filter((value) => /\.(test|spec)\.[A-Za-z0-9]+(?::\d+)?$/i.test(value));
  const effectiveTargets = uniqueValues([...failedTargets, ...fileRefs]);
  const summaryMatch =
    text.match(/Test Files\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?/i) ||
    text.match(/Tests?\s*:\s*(\d+)\s+failed/i);
  const summary = summaryMatch
    ? summaryMatch[2]
      ? `${summaryMatch[1]} failed file${summaryMatch[1] === "1" ? "" : "s"}, ${summaryMatch[2]} passed`
      : `${summaryMatch[1]} failed test target${summaryMatch[1] === "1" ? "" : "s"}`
    : effectiveTargets.length
      ? `${effectiveTargets.length} failing ${runner} target${effectiveTargets.length === 1 ? "" : "s"}`
      : "";
  return {
    failedTargets: effectiveTargets,
    summary,
    rerunCommand: effectiveTargets.length
      ? `${runner === "jest" ? "jest" : "vitest run"} ${effectiveTargets.slice(0, 8).map(quoteArg).join(" ")}`
      : null,
  };
}

function parseGoTest(text) {
  const failedTests = [];
  for (const match of String(text).matchAll(/^--- FAIL:\s+([^\s(]+)/gm)) {
    failedTests.push(match[1]);
  }
  const failedPackages = [];
  for (const match of String(text).matchAll(/^FAIL\t([^\s]+)\t/gm)) {
    failedPackages.push(match[1]);
  }
  const summary = failedTests.length
    ? `${failedTests.length} failing Go test${failedTests.length === 1 ? "" : "s"}`
    : failedPackages.length
      ? `${failedPackages.length} failing Go package${failedPackages.length === 1 ? "" : "s"}`
      : "";
  let rerunCommand = null;
  if (failedTests.length) {
    rerunCommand = `go test ./... -run ${quoteArg(`^(${uniqueValues(failedTests).slice(0, 8).join("|")})$`)}`;
  } else if (failedPackages.length) {
    rerunCommand = `go test ${uniqueValues(failedPackages).slice(0, 8).map(quoteArg).join(" ")}`;
  }
  return {
    failedTargets: uniqueValues([...failedTests, ...failedPackages]),
    summary,
    rerunCommand,
  };
}

function parseGitOutput(text, runner, commandLine) {
  const fileRefs = extractFileRefs(text, 12);
  const diffFiles = countRegex(text, /^diff --git /gm);
  const changedEntries = countRegex(text, /^(M|A|D|R|\?\?)\s+/gm);
  const summary = runner === "git-diff"
    ? diffFiles
      ? `${diffFiles} diff file${diffFiles === 1 ? "" : "s"} in output`
      : fileRefs.length
        ? `${fileRefs.length} referenced file${fileRefs.length === 1 ? "" : "s"} in diff output`
        : ""
    : runner === "git-status"
      ? changedEntries
        ? `${changedEntries} changed path${changedEntries === 1 ? "" : "s"} in status output`
        : ""
      : fileRefs.length
        ? `${fileRefs.length} referenced file${fileRefs.length === 1 ? "" : "s"} in git output`
        : "";
  let rerunCommand = null;
  if (runner === "git-diff" && !/\s--stat\b/.test(commandLine)) {
    rerunCommand = "git diff --stat";
  } else if (runner === "git-status" && !/\s--short\b/.test(commandLine)) {
    rerunCommand = "git status --short";
  }
  return {
    failedTargets: fileRefs,
    summary,
    rerunCommand,
  };
}

function parseGeneric(text) {
  const fileRefs = extractFileRefs(text, 12);
  const errorCount = countRegex(text, /\b(error|failed|fatal|panic|traceback|exception)\b/gi);
  return {
    failedTargets: fileRefs,
    summary: errorCount
      ? `${errorCount} error signal${errorCount === 1 ? "" : "s"} detected`
      : fileRefs.length
        ? `${fileRefs.length} file anchor${fileRefs.length === 1 ? "" : "s"} detected`
        : "",
    rerunCommand: null,
  };
}

function buildDelta(previousTargets = [], currentTargets = []) {
  const prevSet = new Set(previousTargets);
  const currSet = new Set(currentTargets);
  const resolved = previousTargets.filter((value) => !currSet.has(value));
  const remaining = currentTargets.filter((value) => prevSet.has(value));
  const introduced = currentTargets.filter((value) => !prevSet.has(value));
  return {
    resolved: uniqueValues(resolved),
    remaining: uniqueValues(remaining),
    introduced: uniqueValues(introduced),
  };
}

function deriveHint({ family, runner, text, exitCode, insufficientSignal }) {
  const normalized = String(text || "").toLowerCase();
  if (insufficientSignal) {
    return "Signal coverage is low. Retrieve the full log or rerun with a narrower test/build command.";
  }
  if (/econnrefused|connection refused|service unavailable|timed out|timeout/.test(normalized)) {
    return "Check dependent services or network reachability before rerunning.";
  }
  if (/permission denied|eacces|access is denied/.test(normalized)) {
    return "Fix permissions or sandbox access before rerunning.";
  }
  if (/fixture|setup failed|conftest|beforeall|collection failed/.test(normalized)) {
    return "Fix shared setup or fixture failures before rerunning the whole suite.";
  }
  if (family === "git" && exitCode !== 0) {
    return "Narrow the git view first, then inspect the full log if the failure is still unclear.";
  }
  if (runner === "dotnet-test" && /cs\d+|msb\d+|nu\d+/i.test(text)) {
    return "Resolve the reported build or package diagnostics before rerunning tests.";
  }
  return "";
}

function pruneRecords(records) {
  const entries = Object.entries(records || {}).sort((left, right) =>
    String(right[1]?.updatedAt || "").localeCompare(String(left[1]?.updatedAt || "")),
  );
  return Object.fromEntries(entries.slice(0, MAX_STATE_RECORDS));
}

export function renderCommandDiagnosticFooter(diagnostic = null) {
  if (!diagnostic || typeof diagnostic !== "object") return "";
  const lines = [];
  if (diagnostic.summary) lines.push(`Summary: ${diagnostic.summary}`);
  if (diagnostic.deltaSummary) lines.push(`Delta: ${diagnostic.deltaSummary}`);
  if (diagnostic.suggestedRerun) lines.push(`Suggested rerun: ${diagnostic.suggestedRerun}`);
  if (diagnostic.hint) lines.push(`Hint: ${diagnostic.hint}`);
  if (diagnostic.insufficientSignal) lines.push("Signal coverage: low");
  return lines.length ? `Diagnostics:\n${lines.join("\n")}` : "";
}

export async function analyzeCommandDiagnostic(payload = {}) {
  const command = String(payload.command || "").trim();
  const args = Array.isArray(payload.args) ? payload.args.map((value) => String(value || "")) : [];
  const output = String(payload.output || payload.stdout || "");
  const stderr = String(payload.stderr || "");
  const text = [output.trim(), stderr.trim() && stderr.trim() !== output.trim() ? `[stderr]\n${stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!command || !text) return null;

  const commandLine = collapseWhitespace([command, ...args].join(" "));
  const exitCode = Number.isFinite(Number(payload.exitCode)) ? Number(payload.exitCode) : 0;
  const { family, runner } = resolveCommandKind(commandLine, text);

  let parsed;
  switch (runner) {
    case "dotnet-test":
      parsed = parseDotnetTest(text);
      break;
    case "pytest":
      parsed = parsePytest(text);
      break;
    case "vitest":
    case "jest":
      parsed = parseVitestLike(text, runner);
      break;
    case "go-test":
      parsed = parseGoTest(text);
      break;
    case "git":
    case "git-diff":
    case "git-status":
      parsed = parseGitOutput(text, runner, commandLine);
      break;
    default:
      parsed = parseGeneric(text);
      break;
  }

  const failedTargets = uniqueValues(parsed.failedTargets || []);
  const fileAnchors = extractFileRefs(text, 10);
  const insufficientSignal =
    exitCode !== 0 &&
    failedTargets.length === 0 &&
    fileAnchors.length === 0 &&
    !parsed.summary &&
    text.length >= 1200;

  const state = await loadState();
  const commandKey = normalizeCommandSignature(command, args);
  const previous = state.records[commandKey] || null;
  const delta = previous ? buildDelta(previous.failedTargets || [], failedTargets) : null;

  const deltaParts = [];
  if (delta) {
    if (delta.resolved.length) deltaParts.push(`${delta.resolved.length} resolved`);
    if (delta.remaining.length) deltaParts.push(`${delta.remaining.length} still failing`);
    if (delta.introduced.length) deltaParts.push(`${delta.introduced.length} new`);
  }
  const deltaSummary = deltaParts.join(", ");
  const suggestedRerun = parsed.rerunCommand || null;
  const hint = deriveHint({ family, runner, text, exitCode, insufficientSignal });

  state.records[commandKey] = {
    updatedAt: new Date().toISOString(),
    family,
    runner,
    commandLine,
    exitCode,
    failedTargets: failedTargets.slice(0, 40),
    summary: parsed.summary || "",
  };
  state.records = pruneRecords(state.records);
  await saveState(state);

  return {
    family,
    runner,
    commandKey,
    summary: parsed.summary || "",
    failedTargets,
    fileAnchors,
    insufficientSignal,
    deltaSummary,
    resolvedTargets: delta?.resolved || [],
    remainingTargets: delta?.remaining || [],
    newTargets: delta?.introduced || [],
    suggestedRerun,
    hint,
  };
}
