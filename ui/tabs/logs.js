/* ─────────────────────────────────────────────────────────────
 *  Tab: Logs — system logs, agent log library, git snapshot
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  Typography, Box, Stack, Chip, Paper, TextField, InputAdornment,
  Select, MenuItem, FormControl, InputLabel, Button, IconButton, Tooltip,
  CircularProgress, Alert, Switch, FormControlLabel, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Divider, Tabs, Tab,
  LinearProgress, Skeleton, Card, CardContent,
} from "@mui/material";

import { haptic, showAlert, getTg, openLink } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  logsData,
  logsLines,
  gitDiff,
  gitBranches,
  agentLogFiles,
  agentLogFile,
  agentLogTail,
  agentLogLines,
  agentLogQuery,
  agentContext,
  agentWorkspaceTarget,
  loadLogs,
  loadAgentLogFileList,
  loadAgentLogTailData,
  loadAgentContextData,
  showToast,
  scheduleRefresh,
} from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import { iconText } from "../modules/icon-utils.js";
import { formatBytes } from "../modules/utils.js";
import {
  Card as LegacyCard, Badge, EmptyState, SkeletonCard, Modal,
} from "../components/shared.js";
import { SearchInput } from "../components/forms.js";

/* ─── Log level helpers ─── */
const LOG_LEVELS = [
  { value: "all", label: "All", color: "default" },
  { value: "info", label: "Info", color: "info" },
  { value: "warn", label: "Warn", color: "warning" },
  { value: "error", label: "Error", color: "error" },
];

function levelChipColor(line) {
  const l = (line || "").toLowerCase();
  if (l.includes("error") || l.includes("fatal")) return "error";
  if (l.includes("warn")) return "warning";
  if (l.includes("debug")) return "secondary";
  return "info";
}

function filterByLevel(text, level) {
  if (!text || level === "all") return text;
  return text
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase();
      if (level === "error")
        return (
          lower.includes("error") ||
          lower.includes("err") ||
          lower.includes("fatal")
        );
      if (level === "warn")
        return (
          lower.includes("warn") ||
          lower.includes("warning") ||
          lower.includes("error") ||
          lower.includes("fatal")
        );
      return true;
    })
    .join("\n");
}

/* ─── Helpers ─── */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightLine(text, search, isRegex) {
  if (!search || !search.trim()) return text;
  let regex;
  try {
    regex = isRegex
      ? new RegExp(search, "gi")
      : new RegExp(escapeRegex(search), "gi");
  } catch {
    return text;
  }
  const parts = [];
  let lastIndex = 0;
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(html`<mark class="log-hl">${match[0]}</mark>`);
    lastIndex = regex.lastIndex;
    if (match[0].length === 0) {
      regex.lastIndex++;
      if (regex.lastIndex > text.length) break;
    }
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

const LINE_HEIGHT = 20;
const SCROLL_BUFFER = 20;

function isMobileViewport() {
  const tg = getTg?.();
  const platform = String(tg?.platform || "").toLowerCase();
  if (platform === "ios" || platform === "android" || platform === "android_x") {
    return true;
  }
  if (typeof globalThis !== "undefined" && globalThis.matchMedia) {
    return globalThis.matchMedia("(max-width: 680px)").matches;
  }
  return false;
}

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return parseTimestamp(Number(trimmed));

    // Handle log filename timestamps like 2026-02-25T12-36-00-924Z
    const embedded = trimmed.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)/);
    if (embedded?.[1]) {
      const normalized = embedded[1].replace(
        /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/,
        (_m, date, hh, mm, ss, ms) => `${date}T${hh}:${mm}:${ss}${ms ? `.${ms}` : ""}Z`,
      );
      const embeddedDate = new Date(normalized);
      if (Number.isFinite(embeddedDate.getTime())) return embeddedDate;
    }

    const d = new Date(trimmed);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "object") {
    return (
      parseTimestamp(value.mtime) ||
      parseTimestamp(value.mtimeMs) ||
      parseTimestamp(value.updatedAt) ||
      parseTimestamp(value.createdAt) ||
      parseTimestamp(value.timestamp) ||
      parseTimestamp(value.date) ||
      parseTimestamp(value.time) ||
      parseTimestamp(value.seconds) ||
      parseTimestamp(value._seconds) ||
      parseTimestamp(value.sec)
    );
  }
  return null;
}

function formatTimestamp(value, fallback = "Unknown time") {
  const date = parseTimestamp(value);
  return date ? date.toLocaleString() : fallback;
}

function normalizeBranchEntry(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") {
    return (
      entry.raw ||
      entry.name ||
      entry.branch ||
      entry.ref ||
      entry.display ||
      entry.label ||
      ""
    );
  }
  return String(entry);
}

/* ─── LogsTab ─── */
export function LogsTab() {
  const logRef = useRef(null);
  const tailRef = useRef(null);
  const isAtBottomRef = useRef(true);

  const isMobile = useMemo(() => isMobileViewport(), []);
  const [localLogLines, setLocalLogLines] = useState(() => {
    const base = logsLines?.value ?? 200;
    return isMobile ? Math.min(base, 20) : base;
  });
  const [localAgentLines, setLocalAgentLines] = useState(
    agentLogLines?.value ?? 200,
  );
  const [contextQuery, setContextQuery] = useState("");
  const [logLevel, setLogLevel] = useState(isMobile ? "error" : "all");
  const [logSearch, setLogSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [regexMode, setRegexMode] = useState(false);
  const [logScrollTop, setLogScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  const [branchDetail, setBranchDetail] = useState(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState(null);

  useEffect(() => {
    if (!isMobile) return;
    if (logsLines) logsLines.value = 20;
    setLocalLogLines(20);
    setLogLevel("error");
    loadLogs();
  }, [isMobile]);

  const branchFileDetails = useMemo(() => {
    if (!branchDetail) return [];
    if (Array.isArray(branchDetail.filesChanged) && branchDetail.filesChanged.length) {
      return branchDetail.filesChanged;
    }
    if (Array.isArray(branchDetail.filesDetailed) && branchDetail.filesDetailed.length) {
      return branchDetail.filesDetailed;
    }
    if (Array.isArray(branchDetail.files) && branchDetail.files.length) {
      return branchDetail.files.map((file) => ({ file }));
    }
    return [];
  }, [branchDetail]);

  const branchCommits = useMemo(() => {
    if (!branchDetail) return [];
    if (Array.isArray(branchDetail.commitList) && branchDetail.commitList.length) {
      return branchDetail.commitList;
    }
    if (Array.isArray(branchDetail.commits) && branchDetail.commits.length) {
      return branchDetail.commits;
    }
    return [];
  }, [branchDetail]);

  const workspaceLink = useMemo(() => {
    if (!branchDetail) return null;
    return branchDetail.workspaceLink || branchDetail.workspaceTarget || null;
  }, [branchDetail]);

  /* Raw log text */
  const rawLogText = logsData?.value?.lines
    ? logsData.value.lines.join("\n")
    : "No logs yet.";

  const rawTailText = agentLogTail?.value?.lines
    ? agentLogTail.value.lines.join("\n")
    : "Select a log file.";

  /* Filtered log lines (memoized) */
  const { filteredLines, matchCount } = useMemo(() => {
    const leveled = filterByLevel(rawLogText, logLevel);
    const allLines = leveled.split("\n");
    if (!logSearch.trim()) {
      return { filteredLines: allLines, matchCount: 0 };
    }
    let testFn;
    if (regexMode) {
      try {
        const re = new RegExp(logSearch, "i");
        testFn = (line) => re.test(line);
      } catch {
        testFn = (line) =>
          line.toLowerCase().includes(logSearch.toLowerCase());
      }
    } else {
      const q = logSearch.toLowerCase();
      testFn = (line) => line.toLowerCase().includes(q);
    }
    const matched = allLines.filter(testFn);
    if (matched.length === 0) {
      return { filteredLines: ["No matching lines."], matchCount: 0 };
    }
    return { filteredLines: matched, matchCount: matched.length };
  }, [rawLogText, logLevel, logSearch, regexMode]);

  const filteredLogText = filteredLines.join("\n");

  /* Virtual scroll calculations */
  const totalLines = filteredLines.length;
  const firstVisible = Math.floor(logScrollTop / LINE_HEIGHT);
  const startIdx = Math.max(0, firstVisible - SCROLL_BUFFER);
  const visibleCount = Math.ceil(containerHeight / LINE_HEIGHT);
  const endIdx = Math.min(totalLines, firstVisible + visibleCount + SCROLL_BUFFER);
  const topSpacer = startIdx * LINE_HEIGHT;
  const bottomSpacer = Math.max(0, (totalLines - endIdx) * LINE_HEIGHT);
  const visibleLines = filteredLines.slice(startIdx, endIdx);

  /* Scroll handler */
  const handleLogScroll = useCallback((e) => {
    const el = e.target;
    setLogScrollTop(el.scrollTop);
    isAtBottomRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  }, []);

  /* Container height measurement */
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries)
          setContainerHeight(entry.contentRect.height);
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  /* Auto-scroll */
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

  useEffect(() => {
    if (autoScroll && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [rawTailText, autoScroll]);

  /* ── System log handlers ── */
  const handleLogLinesChange = async (value) => {
    setLocalLogLines(value);
    if (logsLines) logsLines.value = value;
    await loadLogs();
  };

  /* ── Agent log handlers ── */
  const handleAgentSearch = async () => {
    if (agentLogFile) agentLogFile.value = "";
    await loadAgentLogFileList();
    await loadAgentLogTailData();
  };

  const normalizeBranchLine = (line) => {
    const rawEntry = normalizeBranchEntry(line);
    if (!rawEntry) return null;
    const cleaned = rawEntry.replace(/^\*\s*/, "").trim();
    const noRemote = cleaned.replace(/^remotes\//, "");
    const short = noRemote.replace(/^origin\//, "");
    return { raw: rawEntry, name: noRemote, short };
  };

  const openBranchDetail = async (line) => {
    const parsed = normalizeBranchLine(line);
    if (!parsed?.name) return;
    setBranchError(null);
    setBranchLoading(true);
    setBranchDetail({ branch: parsed.name });
    try {
      const res = await apiFetch(
        `/api/git/branch-detail?branch=${encodeURIComponent(parsed.name)}`,
      );
      setBranchDetail(res.data || null);
    } catch (err) {
      setBranchError(err.message || "Failed to load branch detail");
    } finally {
      setBranchLoading(false);
    }
  };

  const openWorkspace = (detail) => {
    if (!detail) return;
    const target =
      detail?.workspaceTarget ||
      {
        taskId: detail?.activeSlot?.taskId || detail?.worktree?.taskKey || null,
        taskTitle: detail?.activeSlot?.taskTitle || detail?.branch || "Workspace",
        branch: detail?.branch || null,
      };
    agentWorkspaceTarget.value = {
      taskId: target.taskId || null,
      taskTitle: target.taskTitle || detail?.branch || "Workspace",
      branch: target.branch || detail?.branch || null,
    };
    navigateTo("agents");
  };

  const handleAgentOpen = async (name) => {
    haptic();
    if (agentLogFile) agentLogFile.value = name;
    await loadAgentLogTailData();
  };

  const handleAgentLinesChange = async (value) => {
    setLocalAgentLines(value);
    if (agentLogLines) agentLogLines.value = value;
    await loadAgentLogTailData();
  };

  /* ── Context handler ── */
  const handleContextLoad = async () => {
    haptic();
    await loadAgentContextData(contextQuery.trim());
  };

  /* ── Git handler ── */
  const handleGitRefresh = async () => {
    haptic();
    const [branches, diff] = await Promise.all([
      apiFetch("/api/git/branches", { _silent: true }).catch(() => ({
        data: [],
      })),
      apiFetch("/api/git/diff", { _silent: true }).catch(() => ({ data: "" })),
    ]);
    if (gitBranches) gitBranches.value = branches.data || [];
    if (gitDiff) gitDiff.value = diff.data || "";
  };

  /* ── Copy to clipboard ── */
  const copyToClipboard = async (text, label) => {
    haptic();
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showToast(`${label} copied`, "success");
    } catch {
      showToast("Copy failed", "error");
    }
  };

  /* ── Download logs ── */
  const downloadLogs = useCallback(() => {
    haptic();
    const blob = new Blob([filteredLogText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `bosun-logs-${d}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Log file downloaded", "success");
  }, [filteredLogText]);

  return html`
    <style>
      .log-line { display: flex; align-items: baseline; }
      .log-ln { min-width: 3.5em; text-align: right; padding-right: 8px; opacity: 0.35; user-select: none; font-size: 0.85em; }
      .log-lt { flex: 1; white-space: pre-wrap; word-break: break-all; }
      .log-hl { background: rgba(250,204,21,0.3); border-radius: 2px; padding: 0 1px; }
    </style>
    <!-- Loading skeleton -->
    ${!logsData?.value && !agentLogFiles?.value && html`
      <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
        <${Typography} variant="h6" gutterBottom>Loading Logs…<//>
        <${Skeleton} variant="rectangular" height=${120} />
      <//>
    `}

    <!-- ── System Logs ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>System Logs<//>

      <!-- Line count slider -->
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
        <${TextField}
          type="number" size="small" variant="outlined"
          inputProps=${{ min: 20, max: 800, step: 20 }}
          value=${localLogLines}
          onInput=${(e) => setLocalLogLines(Number(e.target.value))}
          onChange=${(e) => handleLogLinesChange(Number(e.target.value))}
          sx=${{ flex: 1 }}
        />
        <${Chip} label="${localLogLines} lines" size="small" variant="outlined" />
      <//>

      <!-- Quick-select line counts -->
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1 }}>
        ${[50, 200, 500].map(
          (n) => html`
            <${Chip}
              key=${n}
              label=${String(n)}
              size="small"
              color=${(logsLines?.value ?? localLogLines) === n ? "primary" : "default"}
              variant=${(logsLines?.value ?? localLogLines) === n ? "filled" : "outlined"}
              onClick=${() => handleLogLinesChange(n)}
              clickable
            />
          `,
        )}
      <//>

      <!-- Log level filter chips -->
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        ${LOG_LEVELS.map(
          (l) => html`
            <${Chip}
              key=${l.value}
              label=${l.label}
              size="small"
              color=${logLevel === l.value ? l.color : "default"}
              variant=${logLevel === l.value ? "filled" : "outlined"}
              onClick=${() => { haptic(); setLogLevel(l.value); }}
              clickable
            />
          `,
        )}
      <//>

      <!-- Search / regex / auto-scroll controls -->
      <${Stack} direction="row" spacing=${1} alignItems="center" sx=${{ mb: 1.5 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder=${regexMode ? "Regex pattern…" : "Search/grep logs…"}
          value=${logSearch}
          onInput=${(e) => setLogSearch(e.target.value)}
          InputProps=${{
            endAdornment: logSearch.trim() && matchCount > 0
              ? html`<${InputAdornment} position="end">
                  <${Chip} label="${matchCount} matches" size="small" color="info" />
                <//>` : null,
          }}
        />
        <${Tooltip} title="Toggle regex mode">
          <${IconButton}
            size="small"
            color=${regexMode ? "primary" : "default"}
            onClick=${() => { setRegexMode(!regexMode); haptic(); }}
            sx=${{ fontFamily: "monospace", fontWeight: "bold" }}
          >.*<//>
        <//>
        <${FormControlLabel}
          control=${html`<${Switch}
            size="small"
            checked=${autoScroll}
            onChange=${() => { setAutoScroll(!autoScroll); haptic(); }}
          />`}
          label="Auto-scroll"
          sx=${{ whiteSpace: "nowrap", ml: 0.5 }}
        />
      <//>

      <!-- Virtualized log viewer -->
      <${Paper}
        variant="outlined"
        ref=${logRef}
        onScroll=${handleLogScroll}
        sx=${{
          maxHeight: 400, overflow: "auto", p: 1, mb: 1,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >
        <div style="height:${topSpacer}px"></div>
        ${visibleLines.map((line, i) => {
          const lineNum = startIdx + i + 1;
          return html`<div class="log-line" key=${lineNum} style="height:${LINE_HEIGHT}px">
            <${Typography} variant="caption" component="span" className="log-ln" sx=${{ color: "grey.500" }}>${lineNum}<//>
            <span class="log-lt">${logSearch.trim() ? highlightLine(line, logSearch, regexMode) : line}</span>
          </div>`;
        })}
        <div style="height:${bottomSpacer}px"></div>
      <//>

      <!-- Action buttons -->
      <${Stack} direction="row" spacing=${1}>
        <${Tooltip} title="Send logs to chat">
          <${Button} size="small" variant="outlined"
            onClick=${() => sendCommandToChat(`/logs ${logsLines?.value ?? localLogLines}`)}
          >/logs to chat<//>
        <//>
        <${Tooltip} title="Copy logs to clipboard">
          <${Button} size="small" variant="outlined"
            onClick=${() => copyToClipboard(filteredLogText, "Logs")}
          >${iconText(":clipboard: Copy")}<//>
        <//>
        <${Tooltip} title="Download log file">
          <${Button} size="small" variant="outlined"
            onClick=${downloadLogs}
          >${iconText(":save: Download")}<//>
        <//>
      <//>
    <//>

    <!-- ── Agent Log Library ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Agent Log Library<//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder="Search log files"
          value=${agentLogQuery?.value ?? ""}
          onInput=${(e) => { if (agentLogQuery) agentLogQuery.value = e.target.value; }}
        />
        <${Button} size="small" variant="contained" onClick=${handleAgentSearch}>
          ${iconText(":search: Search")}
        <//>
      <//>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5 }}>
        <${TextField}
          type="number" size="small" variant="outlined"
          inputProps=${{ min: 50, max: 800, step: 50 }}
          value=${localAgentLines}
          onInput=${(e) => setLocalAgentLines(Number(e.target.value))}
          onChange=${(e) => handleAgentLinesChange(Number(e.target.value))}
          sx=${{ flex: 1 }}
        />
        <${Chip} label="${localAgentLines} lines" size="small" variant="outlined" />
      <//>
    <//>

    <!-- ── Log Files list ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Log Files<//>
      ${(agentLogFiles?.value || []).length
        ? html`
          <${TableContainer}>
            <${Table} size="small">
              <${TableHead}>
                <${TableRow}>
                  <${TableCell}>Name<//>
                  <${TableCell}>Size<//>
                  <${TableCell}>Modified<//>
                  <${TableCell} align="right">Type<//>
                </${TableRow}>
              <//>
              <${TableBody}>
                ${(agentLogFiles.value || []).map(
                  (file) => html`
                    <${TableRow}
                      key=${file.name}
                      hover
                      sx=${{ cursor: "pointer" }}
                      onClick=${() => handleAgentOpen(file.name)}
                    >
                      <${TableCell}>
                        <${Typography} variant="body2" sx=${{ fontFamily: "monospace" }}>${file.name}<//>
                      <//>
                      <${TableCell}>
                        <${Typography} variant="caption">${formatBytes ? formatBytes(file.size) : Math.round(file.size / 1024) + "kb"}<//>
                      <//>
                      <${TableCell}>
                        <${Typography} variant="caption">${formatTimestamp(file.mtime ?? file.mtimeMs ?? file.updatedAt, "time unknown")}<//>
                      <//>
                      <${TableCell} align="right">
                        <${Chip} label="log" size="small" color="default" variant="outlined" />
                      <//>
                    </${TableRow}>
                  `,
                )}
              <//>
            </${Table}>
          <//>
        `
        : html`<${EmptyState} message="No log files found." />`}
    <//>

    <!-- ── Log Tail viewer ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>${agentLogFile?.value || "Log Tail"}<//>
      ${agentLogTail?.value?.truncated &&
      html`<${Chip} label="Tail clipped" size="small" color="warning" sx=${{ mb: 1 }} />`}
      <${Paper}
        variant="outlined"
        ref=${tailRef}
        sx=${{
          maxHeight: 300, overflow: "auto", p: 1, mb: 1,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >${rawTailText}<//>
      <${Stack} direction="row" spacing=${1}>
        <${Tooltip} title="Copy log tail">
          <${Button} size="small" variant="outlined"
            onClick=${() => copyToClipboard(rawTailText, "Log tail")}
          >${iconText(":clipboard: Copy")}<//>
        <//>
      <//>
    <//>

    <!-- ── Worktree Context ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Worktree Context<//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder="Branch fragment"
          value=${contextQuery}
          onInput=${(e) => setContextQuery(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleContextLoad(); }
          }}
        />
        <${Button} size="small" variant="contained" onClick=${handleContextLoad}>
          ${iconText(":folder: Load")}
        <//>
      <//>
      <${Paper}
        variant="outlined"
        sx=${{
          maxHeight: 260, overflow: "auto", p: 1, mb: 1,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >
        ${agentContext?.value
          ? [
              "Worktree: " + (agentContext.value.name || "?"),
              "",
              agentContext.value.gitLog || "No git log.",
              "",
              agentContext.value.gitStatus || "Clean worktree.",
              "",
              agentContext.value.diffStat || "No diff stat.",
            ].join("\n")
          : "Load a worktree context to view git log/status."}
      <//>
      ${agentContext?.value &&
      html`
        <${Stack} direction="row" spacing=${1}>
          <${Tooltip} title="Copy context">
            <${Button} size="small" variant="outlined"
              onClick=${() =>
                copyToClipboard(
                  [
                    agentContext.value.gitLog,
                    agentContext.value.gitStatus,
                    agentContext.value.diffStat,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  "Context",
                )}
            >${iconText(":clipboard: Copy")}<//>
          <//>
        <//>
      `}
    <//>

    <!-- ── Git Snapshot ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Git Snapshot<//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        <${Button} size="small" variant="contained" onClick=${handleGitRefresh}>
          ${ICONS.refresh} Refresh
        <//>
        <${Button} size="small" variant="outlined"
          onClick=${() => sendCommandToChat("/diff")}
        >/diff<//>
        <${Tooltip} title="Copy diff">
          <${Button} size="small" variant="outlined"
            onClick=${() => copyToClipboard(gitDiff?.value || "", "Diff")}
          >${iconText(":clipboard: Copy")}<//>
        <//>
      <//>
      <${Paper}
        variant="outlined"
        sx=${{
          maxHeight: 300, overflow: "auto", p: 1, mb: 2,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >${gitDiff?.value || "Clean working tree."}<//>

      <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Recent Branches<//>
      ${(gitBranches?.value || []).length
        ? (gitBranches.value || []).map(
            (line, i) => {
              const parsed = normalizeBranchLine(line);
              return html`
                <${Button}
                  key=${i}
                  fullWidth
                  variant="text"
                  size="small"
                  onClick=${() => openBranchDetail(parsed?.name || line)}
                  sx=${{ justifyContent: "space-between", textTransform: "none", mb: 0.5, fontFamily: "monospace" }}
                >
                  <span>${parsed?.short || line}</span>
                  <${Typography} variant="caption" color="text.secondary">${parsed?.raw || line}<//>
                <//>
              `;
            },
          )
        : html`<${Typography} variant="body2" color="text.secondary">No branches found. Click Refresh to re-query git.<//>`}
    <//>

    ${branchDetail &&
    html`
      <${Modal} title="Branch Detail" onClose=${() => setBranchDetail(null)}>
        ${branchLoading && html`<${LinearProgress} sx=${{ mb: 1 }} />`}
        ${branchError && html`<${Alert} severity="error" sx=${{ mb: 1 }}>${branchError}<//>`}
        ${!branchLoading &&
        !branchError &&
        html`
          <${Typography} variant="body2" sx=${{ mb: 1 }}>
            Branch: <${Typography} component="span" sx=${{ fontFamily: "monospace" }}>${branchDetail.branch}<//>
          <//>
          ${branchDetail.base &&
          html`<${Typography} variant="body2" sx=${{ mb: 1 }}>Base: ${branchDetail.base}<//>`}
          ${branchDetail.activeSlot &&
          html`<${Typography} variant="body2" sx=${{ mb: 1 }}>Active Agent: ${branchDetail.activeSlot.taskTitle || branchDetail.activeSlot.taskId}<//>`}
          ${branchDetail.worktree?.path &&
          html`<${Typography} variant="body2" sx=${{ mb: 1 }}>Worktree: <${Typography} component="span" sx=${{ fontFamily: "monospace" }}>${branchDetail.worktree.path}<//><//>`}
          <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
            ${(branchDetail.workspaceTarget || branchDetail.activeSlot || branchDetail.worktree) &&
            html`<${Button} size="small" variant="contained" onClick=${() => openWorkspace(branchDetail)}>
              ${iconText(":search: Open Workspace Viewer")}
            <//>`}
            ${branchDetail.workspaceLink?.url &&
            html`<${Button} size="small" variant="outlined"
              onClick=${() => openLink(branchDetail.workspaceLink.url)}
            >${iconText(":link: Open Workspace Link")}<//>`}
            <${Tooltip} title="Copy diff stats">
              <${Button} size="small" variant="outlined"
                onClick=${() => copyToClipboard(branchDetail.diffStat || "", "Diff")}
              >${iconText(":clipboard: Copy Diff")}<//>
            <//>
          <//>
          ${workspaceLink &&
          html`
            <${Typography} variant="body2" sx=${{ mb: 1 }}>
              Workspace: ${workspaceLink.label || workspaceLink.taskTitle || workspaceLink.branch || "Active"}
              ${(workspaceLink.target?.workspacePath || workspaceLink.workspacePath)
                ? html` · <${Typography} component="span" sx=${{ fontFamily: "monospace" }}>${workspaceLink.target?.workspacePath || workspaceLink.workspacePath}<//>`
                : ""}
            <//>
          `}
          ${branchDetail.diffSummary &&
          html`
            <${Typography} variant="body2" sx=${{ mb: 1 }}>
              Diff: ${branchDetail.diffSummary.totalFiles || 0} files ·
              <${Chip} label="+${branchDetail.diffSummary.totalAdditions || 0}" size="small" color="success" sx=${{ mx: 0.5 }} />
              <${Chip} label="-${branchDetail.diffSummary.totalDeletions || 0}" size="small" color="error" sx=${{ mx: 0.5 }} />
              ${branchDetail.diffSummary.binaryFiles ? html` · <${Chip} label="${branchDetail.diffSummary.binaryFiles} binary" size="small" />` : ""}
            <//>
          `}
          ${branchCommits.length > 0 &&
          html`
            <${Paper} variant="outlined" sx=${{ p: 1.5, mb: 1.5 }}>
              <${Typography} variant="subtitle2" gutterBottom>Commits<//>
              ${branchCommits.map((cm) => {
                const subject = cm.subject || cm.message || "";
                const author =
                  cm.author ||
                  (cm.authorName && cm.authorEmail
                    ? `${cm.authorName} <${cm.authorEmail}>`
                    : cm.authorName || cm.authorEmail || "");
                const dateVal = cm.authorDate || cm.date || cm.time;
                return html`
                  <${Typography} variant="body2" key=${cm.hash} sx=${{ mb: 0.5 }}>
                    <${Typography} component="span" sx=${{ fontFamily: "monospace", mr: 0.5 }}>${cm.hash}<//>
                    ${subject}
                    ${author ? ` · ${author}` : ""}
                    ${(() => { const dateText = formatTimestamp(dateVal, ""); return dateText ? ` · ${dateText}` : ""; })()}
                  <//>
                `;
              })}
            <//>
          `}
          <${Paper} variant="outlined" sx=${{ p: 1.5, mb: 1.5 }}>
            <${Typography} variant="subtitle2" gutterBottom>Files Changed<//>
            ${branchFileDetails.length
              ? html`
                <${TableContainer}>
                  <${Table} size="small">
                    <${TableHead}>
                      <${TableRow}>
                        <${TableCell}>File<//>
                        <${TableCell} align="right">Changes<//>
                      </${TableRow}>
                    <//>
                    <${TableBody}>
                      ${branchFileDetails.map(
                        (f) => html`
                          <${TableRow} key=${f.file}>
                            <${TableCell}>
                              <${Typography} variant="body2" sx=${{ fontFamily: "monospace" }}>${f.file}<//>
                            <//>
                            <${TableCell} align="right">
                              <${Stack} direction="row" spacing=${0.5} justifyContent="flex-end">
                                ${typeof f.additions === "number" &&
                                html`<${Chip} label="+${f.additions}" size="small" color="success" />`}
                                ${typeof f.deletions === "number" &&
                                html`<${Chip} label="-${f.deletions}" size="small" color="error" />`}
                                ${f.binary && html`<${Chip} label="binary" size="small" />`}
                              <//>
                            <//>
                          </${TableRow}>
                        `,
                      )}
                    <//>
                  </${Table}>
                <//>
              `
              : html`<${Typography} variant="body2" color="text.secondary">No diff against base.<//>`}
          <//>
          ${branchDetail.diffStat &&
          html`
            <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
              <${Typography} variant="subtitle2" gutterBottom>Diff Summary<//>
              <pre class="workspace-diff">${branchDetail.diffStat}</pre>
            <//>
          `}
        `}
      <//>
    `}
  `;
}
