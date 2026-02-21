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
import { formatBytes } from "../modules/utils.js";
import { Card, Badge, EmptyState, SkeletonCard, Modal } from "../components/shared.js";
import { SearchInput } from "../components/forms.js";

/* ─── Log level helpers ─── */
const LOG_LEVELS = [
  { value: "all", label: "All" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

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
    if (!line) return null;
    const cleaned = line.replace(/^\*\s*/, "").trim();
    const noRemote = cleaned.replace(/^remotes\//, "");
    const short = noRemote.replace(/^origin\//, "");
    return { raw: line, name: noRemote, short };
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
      .log-line { display: flex; }
      .log-ln { min-width: 3.5em; text-align: right; padding-right: 8px; opacity: 0.35; user-select: none; font-size: 0.85em; }
      .log-lt { flex: 1; white-space: pre-wrap; word-break: break-all; }
      .log-hl { background: rgba(250,204,21,0.3); border-radius: 2px; padding: 0 1px; }
    </style>
    <div class="flex flex-col gap-3 max-w-7xl mx-auto p-2">
    <!-- Loading skeleton -->
    ${!logsData?.value && !agentLogFiles?.value && html`<${Card} title="Loading Logs…"><${SkeletonCard} /><//>`}

    <!-- ── System Logs ── -->
    <${Card} title="System Logs">
      <div class="flex items-center gap-2 mb-2">
        <input
          type="range"
          class="range range-primary range-xs flex-1"
          min="20"
          max="800"
          step="20"
          value=${localLogLines}
          onInput=${(e) => setLocalLogLines(Number(e.target.value))}
          onChange=${(e) => handleLogLinesChange(Number(e.target.value))}
        />
        <span class="badge badge-sm">${localLogLines} lines</span>
      </div>
      <div class="flex flex-wrap gap-1 mb-2">
        ${[50, 200, 500].map(
          (n) => html`
            <button
              key=${n}
              class="btn btn-xs ${(logsLines?.value ?? localLogLines) === n
                ? "btn-primary"
                : "btn-ghost"}"
              onClick=${() => handleLogLinesChange(n)}
            >
              ${n}
            </button>
          `,
        )}
      </div>
      <div class="flex flex-wrap gap-1 mb-2">
        ${LOG_LEVELS.map(
          (l) => html`
            <button
              key=${l.value}
              class="btn btn-xs ${logLevel === l.value ? "btn-primary" : "btn-outline"}"
              onClick=${() => {
                haptic();
                setLogLevel(l.value);
              }}
            >
              ${l.label}
            </button>
          `,
        )}
      </div>
      <div class="flex items-center gap-2 mb-2">
        <input
          class="input input-bordered input-sm flex-1"
          placeholder=${regexMode ? "Regex pattern…" : "Search/grep logs…"}
          value=${logSearch}
          onInput=${(e) => setLogSearch(e.target.value)}
        />
        <button
          class="btn btn-ghost btn-sm"
          style="font-family:monospace;min-width:2.2em;padding:2px 6px;${regexMode ? "background:var(--accent);color:#fff;" : ""}"
          onClick=${() => { setRegexMode(!regexMode); haptic(); }}
          title="Toggle regex mode"
        >.*</button>
        ${logSearch.trim() && matchCount > 0 && html`<span class="badge badge-sm badge-info">${matchCount} matches</span>`}
        <label
          class="text-xs opacity-70 flex items-center gap-1 cursor-pointer"
          style="white-space:nowrap"
          onClick=${() => {
            setAutoScroll(!autoScroll);
            haptic();
          }}
        >
          <input
            type="checkbox"
            checked=${autoScroll}
            style="accent-color:var(--accent)"
          />
          Auto-scroll
        </label>
      </div>
      <div ref=${logRef} class="bg-base-300 rounded-lg p-2 font-mono text-xs max-h-[70vh] overflow-y-auto" onScroll=${handleLogScroll}>
        <div style="height:${topSpacer}px"></div>
        ${visibleLines.map((line, i) => {
          const lineNum = startIdx + i + 1;
          return html`<div class="log-line" key=${lineNum} style="height:${LINE_HEIGHT}px">
            <span class="log-ln">${lineNum}</span>
            <span class="log-lt">${logSearch.trim() ? highlightLine(line, logSearch, regexMode) : line}</span>
          </div>`;
        })}
        <div style="height:${bottomSpacer}px"></div>
      </div>
      <div class="flex flex-wrap gap-2 mt-2">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() =>
            sendCommandToChat(`/logs ${logsLines?.value ?? localLogLines}`)}
        >
          /logs to chat
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => copyToClipboard(filteredLogText, "Logs")}
        >
          📋 Copy
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${downloadLogs}
        >
          💾 Download
        </button>
      </div>
    <//>

    <!-- ── Agent Log Library ── -->
    <${Card} title="Agent Log Library">
      <div class="flex items-center gap-2 mb-2">
        <input
          class="input input-bordered input-sm flex-1"
          placeholder="Search log files"
          value=${agentLogQuery?.value ?? ""}
          onInput=${(e) => {
            if (agentLogQuery) agentLogQuery.value = e.target.value;
          }}
        />
        <button class="btn btn-secondary btn-sm" onClick=${handleAgentSearch}>
          🔍 Search
        </button>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <input
          type="range"
          class="range range-primary range-xs flex-1"
          min="50"
          max="800"
          step="50"
          value=${localAgentLines}
          onInput=${(e) => setLocalAgentLines(Number(e.target.value))}
          onChange=${(e) => handleAgentLinesChange(Number(e.target.value))}
        />
        <span class="badge badge-sm">${localAgentLines} lines</span>
      </div>
    <//>

    <!-- ── Log Files list ── -->
    <${Card} title="Log Files">
      ${(agentLogFiles?.value || []).length
        ? (agentLogFiles.value || []).map(
            (file) => html`
              <div
                key=${file.name}
                class="card bg-base-200 shadow-sm mb-2 cursor-pointer"
                onClick=${() => handleAgentOpen(file.name)}
              >
                <div class="card-body p-3 flex flex-row items-center justify-between">
                  <div>
                    <div class="font-semibold text-sm truncate">${file.name}</div>
                    <div class="text-xs opacity-60">
                      ${formatBytes
                        ? formatBytes(file.size)
                        : Math.round(file.size / 1024) + "kb"}
                      · ${new Date(file.mtime).toLocaleString()}
                    </div>
                  </div>
                  <${Badge} status="log" text="log" />
                </div>
              </div>
            `,
          )
        : html`<${EmptyState} message="No log files found." />`}
    <//>

    <!-- ── Log Tail viewer ── -->
    <${Card} title=${agentLogFile?.value || "Log Tail"}>
      ${agentLogTail?.value?.truncated &&
      html`<span class="badge badge-sm badge-warning mb-2">Tail clipped</span>`}
      <div ref=${tailRef} class="bg-base-300 rounded-lg p-4 font-mono text-xs overflow-x-auto max-h-[50vh] overflow-y-auto">${rawTailText}</div>
      <div class="flex flex-wrap gap-2 mt-2">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => copyToClipboard(rawTailText, "Log tail")}
        >
          📋 Copy
        </button>
      </div>
    <//>

    <!-- ── Worktree Context ── -->
    <${Card} title="Worktree Context">
      <div class="flex items-center gap-2 mb-2">
        <input
          class="input input-bordered input-sm flex-1"
          placeholder="Branch fragment"
          value=${contextQuery}
          onInput=${(e) => setContextQuery(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleContextLoad(); }
          }}
        />
        <button class="btn btn-secondary btn-sm" onClick=${handleContextLoad}>
          📂 Load
        </button>
      </div>
      <div class="bg-base-300 rounded-lg p-4 font-mono text-xs overflow-x-auto max-h-[50vh] overflow-y-auto">
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
      </div>
      ${agentContext?.value &&
      html`
        <div class="flex flex-wrap gap-2 mt-2">
          <button
            class="btn btn-ghost btn-sm"
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
          >
            📋 Copy
          </button>
        </div>
      `}
    <//>

    <!-- ── Git Snapshot ── -->
    <${Card} title="Git Snapshot">
      <div class="flex flex-wrap gap-2 mb-2">
        <button class="btn btn-secondary btn-sm" onClick=${handleGitRefresh}>
          ${ICONS.refresh} Refresh
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/diff")}
        >
          /diff
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => copyToClipboard(gitDiff?.value || "", "Diff")}
        >
          📋 Copy
        </button>
      </div>
      <div class="bg-base-300 rounded-lg p-4 font-mono text-xs overflow-x-auto max-h-[50vh] overflow-y-auto mb-3">
        ${gitDiff?.value || "Clean working tree."}
      </div>
      <div class="text-sm font-semibold opacity-80 mt-2 mb-1">Recent Branches</div>
      ${(gitBranches?.value || []).length
        ? (gitBranches.value || []).map(
            (line, i) => {
              const parsed = normalizeBranchLine(line);
              return html`
                <button
                  key=${i}
                  class="flex items-center justify-between w-full text-left py-1 px-2 rounded hover:bg-base-300 cursor-pointer"
                  onClick=${() => openBranchDetail(line)}
                >
                  <span class="font-mono text-sm truncate">${parsed?.short || line}</span>
                  <span class="text-xs opacity-50 truncate ml-2">${line}</span>
                </button>
              `;
            },
          )
        : html`<div class="text-xs opacity-70">No branches found.</div>`}
    <//>

    ${branchDetail &&
    html`
      <${Modal} title="Branch Detail" onClose=${() => setBranchDetail(null)}>
        ${branchLoading && html`<${SkeletonCard} height="80px" />`}
        ${branchError && html`<div class="text-xs opacity-70" style="color:var(--color-error)">${branchError}</div>`}
        ${!branchLoading &&
        !branchError &&
        html`
          <div class="text-xs opacity-70 mb-2">
            Branch: <span class="font-mono">${branchDetail.branch}</span>
          </div>
          ${branchDetail.base &&
          html`<div class="text-xs opacity-70 mb-2">Base: ${branchDetail.base}</div>`}
          ${branchDetail.activeSlot &&
          html`<div class="text-xs opacity-70 mb-2">Active Agent: ${branchDetail.activeSlot.taskTitle || branchDetail.activeSlot.taskId}</div>`}
          ${branchDetail.worktree?.path &&
          html`<div class="text-xs opacity-70 mb-2">Worktree: <span class="font-mono">${branchDetail.worktree.path}</span></div>`}
          <div class="flex flex-wrap gap-2 mb-2">
            ${(branchDetail.workspaceTarget || branchDetail.activeSlot || branchDetail.worktree) &&
            html`<button class="btn btn-primary btn-sm" onClick=${() => openWorkspace(branchDetail)}>
              🔍 Open Workspace Viewer
            </button>`}
            ${branchDetail.workspaceLink?.url &&
            html`<button
              class="btn btn-secondary btn-sm"
              onClick=${() => openLink(branchDetail.workspaceLink.url)}
            >
              🔗 Open Workspace Link
            </button>`}
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => copyToClipboard(branchDetail.diffStat || "", "Diff")}
            >📋 Copy Diff</button>
          </div>
          ${workspaceLink &&
          html`
            <div class="text-xs opacity-70 mb-2">
              Workspace: ${workspaceLink.label || workspaceLink.taskTitle || workspaceLink.branch || "Active"}
              ${(workspaceLink.target?.workspacePath || workspaceLink.workspacePath)
                ? html`<span class="font-mono"> · ${workspaceLink.target?.workspacePath || workspaceLink.workspacePath}</span>`
                : ""}
            </div>
          `}
          ${branchDetail.diffSummary &&
          html`
            <div class="text-xs opacity-70 mb-2">
              Diff: ${branchDetail.diffSummary.totalFiles || 0} files ·
              +${branchDetail.diffSummary.totalAdditions || 0} ·
              -${branchDetail.diffSummary.totalDeletions || 0}
              ${branchDetail.diffSummary.binaryFiles ? `· ${branchDetail.diffSummary.binaryFiles} binary` : ""}
            </div>
          `}
          ${branchCommits.length > 0 &&
          html`
            <div class="card bg-base-200 shadow-sm mb-2">
              <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Commits</div>
              ${branchCommits.map((cm) => {
                const subject = cm.subject || cm.message || "";
                const author =
                  cm.author ||
                  (cm.authorName && cm.authorEmail
                    ? `${cm.authorName} <${cm.authorEmail}>`
                    : cm.authorName || cm.authorEmail || "");
                const dateVal = cm.authorDate || cm.date || cm.time;
                return html`
                  <div class="text-xs opacity-70" key=${cm.hash}>
                    <span class="font-mono">${cm.hash}</span> ${subject}
                    ${author ? `· ${author}` : ""}
                    ${dateVal ? `· ${new Date(dateVal).toLocaleString()}` : ""}
                  </div>
                `;
              })}
              </div>
            </div>
          `}
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1">Files Changed</div>
            ${branchFileDetails.length
              ? branchFileDetails.map(
                  (f) => html`
                    <div class="text-xs opacity-70" key=${f.file}>
                      <span class="font-mono">${f.file}</span>
                      ${typeof f.additions === "number" &&
                      html`<span class="badge badge-sm badge-success ml-1">+${f.additions}</span>`}
                      ${typeof f.deletions === "number" &&
                      html`<span class="badge badge-sm badge-error ml-1">-${f.deletions}</span>`}
                      ${f.binary && html`<span class="badge badge-sm ml-1">binary</span>`}
                    </div>
                  `,
                )
              : html`<div class="text-xs opacity-70">No diff against base.</div>`}
            </div>
          </div>
          ${branchDetail.diffStat &&
          html`
            <div class="card bg-base-200 shadow-sm">
              <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Diff Summary</div>
              <pre class="bg-base-300 rounded-lg p-4 font-mono text-xs overflow-x-auto">${branchDetail.diffStat}</pre>
              </div>
            </div>
          `}
        `}
      <//>
    `}
    </div>
  `;
}
