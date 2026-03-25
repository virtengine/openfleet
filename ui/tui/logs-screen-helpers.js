import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILTIN_LOG_SOURCES = ["monitor", "agent-pool", "workflow", "telegram-ui", "kanban"];
export const LOG_RING_BUFFER_LIMIT = 2000;
export const LOG_LEVEL_FILTERS = Object.freeze({
  ALL: "all",
  INFO_PLUS: "info+",
  WARN_PLUS: "warn+",
  ERRORS_ONLY: "errors",
});

const LEVEL_ORDER = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  warning: 30,
  error: 40,
});

export function createDefaultLogsFilterState() {
  return {
    levelMode: LOG_LEVEL_FILTERS.ALL,
    searchText: "",
    searchOpen: false,
    filterBarOpen: false,
    sources: Object.fromEntries(BUILTIN_LOG_SOURCES.map((source) => [source, true])),
  };
}

export function getActiveLogSources(filterState) {
  return Object.entries(filterState?.sources || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([source]) => source)
    .sort();
}

export function ensureLogSource(filterState, sourceKey, enabled = true) {
  if (!sourceKey) return filterState;
  if (Object.prototype.hasOwnProperty.call(filterState?.sources || {}, sourceKey)) return filterState;
  return {
    ...(filterState || createDefaultLogsFilterState()),
    sources: {
      ...((filterState && filterState.sources) || {}),
      [sourceKey]: enabled,
    },
  };
}

export function toggleLogSource(filterState, sourceKey) {
  const base = filterState || createDefaultLogsFilterState();
  if (!Object.prototype.hasOwnProperty.call(base.sources || {}, sourceKey)) {
    return ensureLogSource(base, sourceKey, true);
  }
  return {
    ...base,
    sources: {
      ...base.sources,
      [sourceKey]: !base.sources[sourceKey],
    },
  };
}

export function normalizeLogEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    ts: entry.ts || new Date().toISOString(),
    level: String(entry.level || "info").toLowerCase(),
    source: String(entry.source || "monitor"),
    sessionId: entry.sessionId || null,
    message: String(entry.message || ""),
  };
}

export function appendLogEntry(entries = [], entry) {
  const normalized = normalizeLogEntry(entry);
  if (!normalized) return entries;
  const nextEntries = [...entries, normalized];
  if (nextEntries.length <= LOG_RING_BUFFER_LIMIT) return nextEntries;
  return nextEntries.slice(nextEntries.length - LOG_RING_BUFFER_LIMIT);
}

export function formatLogTimestamp(ts) {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--.---";
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function matchesLevel(entry, levelMode) {
  const value = LEVEL_ORDER[String(entry?.level || "info").toLowerCase()] || LEVEL_ORDER.info;
  if (levelMode === LOG_LEVEL_FILTERS.INFO_PLUS) return value >= LEVEL_ORDER.info;
  if (levelMode === LOG_LEVEL_FILTERS.WARN_PLUS) return value >= LEVEL_ORDER.warn;
  if (levelMode === LOG_LEVEL_FILTERS.ERRORS_ONLY) return value >= LEVEL_ORDER.error;
  return true;
}

function matchesSource(entry, filterState) {
  const sources = filterState?.sources || {};
  const sourceEnabled = sources[entry.source] !== false;
  const sessionKey = entry.sessionId ? `session:${entry.sessionId}` : null;
  const hasAnySessionFilters = Object.keys(sources).some((key) => key.startsWith("session:"));
  const sessionEnabled = !sessionKey
    ? true
    : hasAnySessionFilters
      ? sources[sessionKey] === true
      : sources[sessionKey] !== false;
  return sourceEnabled && sessionEnabled;
}

function matchesSearch(entry, searchText) {
  const text = String(searchText || "").trim().toLowerCase();
  if (!text) return true;
  return `${entry.message} ${entry.source} ${entry.sessionId || ""}`.toLowerCase().includes(text);
}

export function filterLogEntries(entries = [], filterState = createDefaultLogsFilterState()) {
  return entries.filter((entry) => (
    matchesLevel(entry, filterState.levelMode)
    && matchesSource(entry, filterState)
    && matchesSearch(entry, filterState.searchText)
  ));
}

export function buildSearchMatches(text, searchText) {
  const source = String(text || "");
  const needle = String(searchText || "").trim().toLowerCase();
  if (!needle) return [];
  const haystack = source.toLowerCase();
  const matches = [];
  let startIndex = 0;
  while (startIndex < haystack.length) {
    const matchIndex = haystack.indexOf(needle, startIndex);
    if (matchIndex === -1) break;
    matches.push({ start: matchIndex, end: matchIndex + needle.length });
    startIndex = matchIndex + needle.length;
  }
  return matches;
}

export function cycleLogLevelFilter(levelMode) {
  const order = [
    LOG_LEVEL_FILTERS.ALL,
    LOG_LEVEL_FILTERS.INFO_PLUS,
    LOG_LEVEL_FILTERS.WARN_PLUS,
    LOG_LEVEL_FILTERS.ERRORS_ONLY,
  ];
  const index = Math.max(0, order.indexOf(levelMode));
  return order[(index + 1) % order.length];
}

export function buildExportFileName(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `bosun-${year}-${month}-${day}T${hours}-${minutes}-${seconds}.log`;
}

export function formatVisibleLogLine(entry) {
  const normalized = normalizeLogEntry(entry);
  if (!normalized) return "";
  const level = String(normalized.level || "info").toUpperCase();
  return `${formatLogTimestamp(normalized.ts)} | ${level} | ${normalized.source}${normalized.sessionId ? `/${normalized.sessionId}` : ""} | ${normalized.message}`;
}

export function exportVisibleLogs({ cwd = process.cwd(), entries = [], date = new Date() } = {}) {
  const logsDir = join(cwd, "logs");
  mkdirSync(logsDir, { recursive: true });
  const fileName = buildExportFileName(date);
  const filePath = join(logsDir, fileName);
  const contents = entries.join("\n");
  writeFileSync(filePath, contents, "utf8");
  return { fileName, filePath, relativePath: `logs/${fileName}` };
}

export function getLogSourceOptions(filterState, entries = []) {
  const discoveredSessions = new Set();
  for (const entry of entries) {
    if (entry?.sessionId) discoveredSessions.add(entry.sessionId);
  }
  const sessionOptions = Array.from(discoveredSessions)
    .sort()
    .map((sessionId) => ({ key: `session:${sessionId}`, label: sessionId }));
  const builtinOptions = BUILTIN_LOG_SOURCES.map((source) => ({ key: source, label: source }));
  return [...builtinOptions, ...sessionOptions].map((option) => ({
    ...option,
    enabled: (filterState?.sources || {})[option.key] !== false,
  }));
}

export function wrapText(text, width) {
  const source = String(text || "");
  const safeWidth = Math.max(8, width);
  const lines = [];
  for (const paragraph of source.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let offset = 0;
    while (offset < paragraph.length) {
      lines.push(paragraph.slice(offset, offset + safeWidth));
      offset += safeWidth;
    }
  }
  return lines.length ? lines : [""];
}

export function wrapLogEntryRows(entries = [], { terminalWidth = 120 } = {}) {
  const messageWidth = Math.max(20, terminalWidth - 32);
  return entries.flatMap((entry, entryIndex) => {
    const normalized = normalizeLogEntry(entry);
    if (!normalized) return [];
    const sourceLabel = normalized.sessionId ? `${normalized.source}/${normalized.sessionId}` : normalized.source;
    const prefix = `${formatLogTimestamp(normalized.ts)} | ${String(normalized.level || "info").toUpperCase().padEnd(5)} | ${sourceLabel} | `;
    const wrapped = wrapText(normalized.message, messageWidth);
    const matchCount = buildSearchMatches(normalized.message, "").length;
    return wrapped.map((line, lineIndex) => ({
      id: `${normalized.ts}-${normalized.source}-${normalized.sessionId || "none"}-${entryIndex}-${lineIndex}`,
      entryId: `${normalized.ts}-${normalized.source}-${normalized.sessionId || "none"}-${entryIndex}`,
      entry: normalized,
      prefix: lineIndex === 0 ? prefix : " ".repeat(prefix.length),
      line,
      matchCount,
    }));
  });
}

export function getSearchResultNavigation(entries = [], searchText = "") {
  const matches = [];
  entries.forEach((entry, index) => {
    const normalized = normalizeLogEntry(entry);
    if (!normalized) return;
    const found = buildSearchMatches(normalized.message, searchText);
    found.forEach((match, matchIndex) => {
      matches.push({
        entryId: `${normalized.ts}-${normalized.source}-${normalized.sessionId || "none"}-${index}`,
        entryIndex: index,
        matchIndex,
        start: match.start,
        end: match.end,
      });
    });
  });
  return { matches, total: matches.length };
}
