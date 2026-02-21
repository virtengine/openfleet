/* ─────────────────────────────────────────────────────────────
 *  Tab: Agents — thread/slot cards, capacity, detail expansion
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  executorData,
  agentsData,
  agentLogQuery,
  agentLogFile,
  agentWorkspaceTarget,
  showToast,
  refreshTab,
  scheduleRefresh,
} from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import { formatRelative, truncate } from "../modules/utils.js";
import {
  Card,
  Badge,
  StatCard,
  SkeletonCard,
  EmptyState,
} from "../components/shared.js";
import { ProgressBar } from "../components/charts.js";
import { Collapsible } from "../components/forms.js";
import {
  SessionList,
  loadSessions,
  loadSessionMessages,
  selectedSessionId,
  sessionsData,
  sessionMessages,
} from "../components/session-list.js";
import { ChatView } from "../components/chat-view.js";
import { DiffViewer } from "../components/diff-viewer.js";

/* ─── Status indicator helpers ─── */
function statusColor(s) {
  const map = {
    idle: "var(--color-todo)",
    busy: "var(--color-inprogress)",
    running: "var(--color-inprogress)",
    error: "var(--color-error)",
    done: "var(--color-done)",
  };
  return map[(s || "").toLowerCase()] || "var(--text-secondary)";
}

function StatusDot({ status }) {
  return html`<span
    class="w-2 h-2 rounded-full inline-block shrink-0"
    style="background:${statusColor(status)}"
  ></span>`;
}

/* ─── Duration formatting ─── */
function formatDuration(startedAt) {
  if (!startedAt) return "";
  const sec = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/* ─── Workspace Viewer Modal ─── */
function WorkspaceViewer({ agent, onClose }) {
  const [logText, setLogText] = useState("Loading…");
  const [contextData, setContextData] = useState(null);
  const [steerInput, setSteerInput] = useState("");
  const [activeTab, setActiveTab] = useState("stream");
  const [streamPaused, setStreamPaused] = useState(false);
  const [streamFilter, setStreamFilter] = useState("all");
  const [streamSearch, setStreamSearch] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [fileSearch, setFileSearch] = useState("");
  const [streamSnapshot, setStreamSnapshot] = useState({
    events: [],
    fileAccess: null,
    capturedAt: null,
  });
  const logRef = useRef(null);

  const query = agent.branch || agent.taskId || agent.sessionId || "";
  const sessionId =
    contextData?.session?.id || agent.taskId || agent.sessionId || null;

  useEffect(() => {
    if (!query) return;
    let active = true;

    const fetchLogs = () => {
      apiFetch(`/api/agent-logs/tail?query=${encodeURIComponent(query)}&lines=200`, { _silent: true })
        .then((res) => {
          if (!active) return;
          const data = res.data ?? res ?? "";
          const content =
            typeof data === "string"
              ? data
              : data?.content || data?.lines || data?.data || "";
          const text = Array.isArray(content)
            ? content.join("\n")
            : content || "";
          setLogText(text || "(no logs yet)");
          if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        })
        .catch(() => { if (active) setLogText("(failed to load logs)"); });
    };

    const fetchContext = () => {
      apiFetch(`/api/agent-context?query=${encodeURIComponent(query)}`, { _silent: true })
        .then((res) => { if (active) setContextData(res.data ?? res ?? null); })
        .catch(() => {});
    };

    fetchLogs();
    fetchContext();
    const interval = setInterval(() => {
      fetchLogs();
      fetchContext();
    }, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [query]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const fetchSession = () => {
      if (!active) return;
      loadSessionMessages(sessionId);
    };
    fetchSession();
    const interval = setInterval(fetchSession, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [sessionId]);

  useEffect(() => {
    setStreamPaused(false);
    setStreamFilter("all");
    setStreamSearch("");
    setFileFilter("all");
    setFileSearch("");
    setStreamSnapshot({ events: [], fileAccess: null, capturedAt: null });
  }, [query]);

  const handleStop = async () => {
    if (agent.index == null) return;
    const ok = await showConfirm(`Force-stop agent on "${truncate(agent.taskTitle || agent.taskId || "task", 40)}"?`);
    if (!ok) return;
    haptic("heavy");
    try {
      await apiFetch("/api/executor/stop-slot", {
        method: "POST",
        body: JSON.stringify({ slotIndex: agent.index, taskId: agent.taskId }),
      });
      showToast("Stop signal sent", "success");
      onClose();
      scheduleRefresh(200);
    } catch { /* toast via apiFetch */ }
  };

  const handleSteer = () => {
    if (!steerInput.trim()) return;
    sendCommandToChat(`/steer ${steerInput.trim()}`);
    showToast("Steer command sent", "success");
    setSteerInput("");
  };

  const copyToClipboard = (text, successMessage) => {
    if (!text) return;
    if (!navigator?.clipboard?.writeText) {
      showToast("Clipboard unavailable", "error");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(successMessage || "Copied", "success"))
      .catch(() => showToast("Copy failed", "error"));
  };

  const downloadText = (filename, content) => {
    if (!content) return;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const renderChanges = () => {
    const ctx = contextData?.context;
    const matches = contextData?.matches || {};
    const diagnostics = contextData?.diagnostics || {};
    const sessionInfo = contextData?.session || null;
    const slotInfo = contextData?.slot || null;
    const actionHistory = contextData?.actionHistory || contextData?.toolHistory || [];
    const fileAccess = contextData?.fileAccessSummary || null;
    const fileAccessFiles = fileAccess?.files || [];
    const streamMessages = sessionMessages.value || [];
    const rawToolEvents = streamMessages
      .filter((msg) => msg?.type === "tool_call" || msg?.type === "tool_result" || msg?.type === "error")
      .slice(-200)
      .map((evt, index) => ({
        ...evt,
        _id: evt?.id || `${evt?.type || "evt"}-${evt?.timestamp || evt?.createdAt || index}`,
      }));
    const liveToolEvents = rawToolEvents.slice().reverse();
    const liveFileAccess = (() => {
      const map = new Map();
      const counts = { read: 0, write: 0, other: 0 };
      const filePattern = /([a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|mdx|css|scss|less|html|yml|yaml|toml|env|lock|go|rs|py|sh|ps1|psm1|txt|sql))/g;
      const classify = (detail) => {
        const lowered = String(detail || "").toLowerCase();
        if (lowered.includes("apply_patch") || lowered.includes("write")) return "write";
        if (/\b(rg|cat|sed|ls|stat|head|tail|grep|find)\b/.test(lowered)) return "read";
        return "other";
      };
      const addFile = (path, kind) => {
        if (!path) return;
        const entry = map.get(path) || { path, kinds: new Set() };
        if (!entry.kinds.has(kind)) {
          entry.kinds.add(kind);
          if (counts[kind] != null) counts[kind] += 1;
          else counts.other += 1;
        }
        map.set(path, entry);
      };
      for (const evt of rawToolEvents) {
        if (!evt?.content) continue;
        const kind = classify(evt.content);
        const matches = evt.content.matchAll(filePattern);
        for (const match of matches) {
          addFile(match?.[1], kind);
        }
      }
      for (const changed of fileAccessFiles) {
        if (changed?.path) addFile(changed.path, "write");
      }
      if (map.size === 0) return null;
      return {
        files: Array.from(map.values()).map((entry) => ({
          path: entry.path,
          kinds: Array.from(entry.kinds),
        })),
        counts,
      };
    })();
    const toolEvents = streamPaused ? streamSnapshot.events : liveToolEvents;
    const snapshotMeta = streamPaused ? streamSnapshot.capturedAt : null;

    const formatReason = (reason) => {
      const map = {
        "no-matching-slots-or-worktrees": "No matching active slots or worktrees found.",
        "no-session-match": "No matching session found.",
        "no-worktree-match": "No matching worktree found.",
        "worktree-path-missing": "Matched worktree path missing or inaccessible.",
      };
      return map[reason] || reason;
    };

    const renderMatchList = (title, items, renderItem) => {
      if (!items || items.length === 0) return null;
      return html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1">${title}</div>
            ${items.map((item, i) => html`
              <div class="text-xs text-base-content/60" key=${i}>
                ${renderItem(item)}
              </div>
            `)}
          </div>
        </div>
      `;
    };

    const hasMatches =
      (matches.worktrees && matches.worktrees.length > 0) ||
      (matches.slots && matches.slots.length > 0) ||
      (matches.sessions && matches.sessions.length > 0);
    const hasActions = actionHistory.length > 0 || toolEvents.length > 0;
    const hasFileAccess = fileAccessFiles.length > 0 || liveFileAccess?.files?.length > 0;
    const showUnavailable =
      !ctx &&
      !sessionInfo &&
      !slotInfo &&
      !hasMatches &&
      !hasActions &&
      !hasFileAccess;

    if (showUnavailable) {
      const reasons = diagnostics?.reasons || [];
      const hints = diagnostics?.hints || [];
      return html`
        <div class="flex flex-col gap-2 overflow-auto p-2">
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Workspace Context Unavailable</div>
              <div class="text-xs text-base-content/60">Query: ${contextData?.query || query || "unknown"}</div>
              ${reasons.length > 0 &&
                html`<div class="text-xs text-base-content/60 mt-1">
                  ${reasons.map((r) => formatReason(r)).join(" ")}
                </div>`}
              ${hints.length > 0 &&
                html`<div class="text-xs text-base-content/60 mt-1">
                  ${hints.join(" ")}
                </div>`}
              ${(diagnostics?.searched?.activeSlots != null ||
                diagnostics?.searched?.activeWorktrees != null ||
                diagnostics?.searched?.sessions != null) &&
                html`<div class="text-xs text-base-content/60 mt-1">
                  Searched: ${diagnostics?.searched?.activeSlots ?? 0} slots · ${diagnostics?.searched?.activeWorktrees ?? 0} worktrees · ${diagnostics?.searched?.sessions ?? 0} sessions
                </div>`}
            </div>
          </div>

          ${renderMatchList("Worktree Matches", matches.worktrees, (wt) =>
            html`<span class="font-mono">${wt.name || wt.branch || "worktree"}</span> ${wt.path ? `· ${wt.path}` : ""}`)}
          ${renderMatchList("Slot Matches", matches.slots, (slot) =>
            html`<span class="font-mono">${slot.taskId || slot.taskTitle || "slot"}</span> ${slot.branch ? `· ${slot.branch}` : ""}`)}
          ${renderMatchList("Session Matches", matches.sessions, (sess) =>
            html`<span class="font-mono">${sess.id || sess.taskId || "session"}</span> ${sess.status ? `· ${sess.status}` : ""}`)}

          ${sessionInfo && html`
            <div class="card bg-base-200 shadow-sm mb-2">
              <div class="card-body p-3">
                <div class="font-semibold text-sm mb-1">Session</div>
                <div class="text-xs text-base-content/60">
                  <span class="font-mono">${sessionInfo.id || sessionInfo.taskId}</span>
                  ${sessionInfo.status ? ` · ${sessionInfo.status}` : ""}
                </div>
                ${sessionInfo.preview &&
                  html`<div class="text-xs text-base-content/60 mt-1">${truncate(sessionInfo.preview, 120)}</div>`}
                <button class="btn btn-ghost btn-sm mt-2" onClick=${() => setActiveTab("stream")}>
                  💬 View Stream
                </button>
              </div>
            </div>
          `}
        </div>
      `;
    }

    const renderActionHistory = () => {
      if (!sessionInfo && actionHistory.length === 0) return null;
      return html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1">Action History</div>
            ${actionHistory.length === 0 &&
              html`<div class="text-xs text-base-content/60">No recent tool actions recorded</div>`}
            ${actionHistory.map((action, i) => {
              const label =
                action.type === "tool_result"
                  ? "RESULT"
                  : action.tool || "TOOL";
              const detail = action.detail || action.content || "";
              return html`
                <div class="text-xs text-base-content/60" key=${i}>
                  <span class="font-mono">${label}</span>
                  ${detail ? ` ${truncate(detail, 140)}` : ""}
                  ${action.timestamp ? ` · ${formatRelative(action.timestamp)}` : ""}
                </div>
              `;
            })}
          </div>
        </div>
      `;
    };

    const renderLiveToolEvents = () => {
      if (!sessionInfo && toolEvents.length === 0) return null;
      const counts = toolEvents.reduce(
        (acc, evt) => {
          acc.all += 1;
          if (evt.type === "tool_result") acc.result += 1;
          else if (evt.type === "error") acc.error += 1;
          else acc.tool += 1;
          return acc;
        },
        { all: 0, tool: 0, result: 0, error: 0 },
      );
      const search = streamSearch.trim().toLowerCase();
      const filteredEvents = toolEvents.filter((evt) => {
        if (streamFilter !== "all") {
          if (streamFilter === "tool" && evt.type !== "tool_call") return false;
          if (streamFilter === "result" && evt.type !== "tool_result") return false;
          if (streamFilter === "error" && evt.type !== "error") return false;
        }
        if (!search) return true;
        const haystack = `${evt.tool || ""} ${evt.content || ""} ${evt.detail || ""}`
          .toLowerCase();
        return haystack.includes(search);
      });
      const exportText = filteredEvents.map((evt) => {
        const label = evt.type === "tool_result" ? "RESULT" : evt.type === "error" ? "ERROR" : "TOOL";
        const ts = evt.timestamp || evt.createdAt || "";
        const tool = evt.tool ? ` ${evt.tool}` : "";
        const body = evt.content || evt.detail || "";
        return `${ts ? `[${ts}] ` : ""}${label}${tool} ${body}`.trim();
      }).join("\n");
      const toolLabel = (type) => (
        type === "tool_result" ? "RESULT" : type === "error" ? "ERROR" : "TOOL"
      );
      return html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1">Live Tool/Event Stream</div>
            <div class="flex flex-wrap items-center gap-2 mb-2">
              <div class="flex flex-wrap gap-1">
                <button
                  class="btn btn-xs ${streamFilter === "all" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setStreamFilter("all")}
                >
                  All (${counts.all})
                </button>
                <button
                  class="btn btn-xs ${streamFilter === "tool" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setStreamFilter("tool")}
                >
                  Tool (${counts.tool})
                </button>
                <button
                  class="btn btn-xs ${streamFilter === "result" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setStreamFilter("result")}
                >
                  Result (${counts.result})
                </button>
                <button
                  class="btn btn-xs ${streamFilter === "error" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setStreamFilter("error")}
                >
                  Error (${counts.error})
                </button>
              </div>
              <div class="flex items-center gap-1 ml-auto">
                <div class="join">
                  <span class="icon-inline">${ICONS.search}</span>
                  <input
                    class="input input-bordered input-sm"
                    placeholder="Filter events..."
                    value=${streamSearch}
                    onInput=${(e) => setStreamSearch(e.target.value)}
                  />
                </div>
              <button class="btn btn-ghost btn-sm" onClick=${() => {
                if (!streamPaused) {
                  setStreamSnapshot({
                    events: liveToolEvents,
                    fileAccess: liveFileAccess,
                    capturedAt: new Date().toISOString(),
                  });
                  setStreamPaused(true);
                } else {
                  setStreamPaused(false);
                  setStreamSnapshot({ events: [], fileAccess: null, capturedAt: null });
                }
              }}>
                ${streamPaused ? "▶ Resume" : "⏸ Pause"}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                onClick=${() => copyToClipboard(exportText, "Stream copied")}
                disabled=${filteredEvents.length === 0}
              >
                <span class="icon-inline">${ICONS.copy}</span> Copy
              </button>
              <button
                class="btn btn-ghost btn-sm"
                onClick=${() => downloadText(
                  `tool-stream-${agent.taskId || agent.branch || "agent"}.txt`,
                  exportText,
                )}
                disabled=${filteredEvents.length === 0}
              >
                <span class="icon-inline">${ICONS.download}</span> Export
              </button>
              </div>
            </div>
            ${streamPaused && snapshotMeta &&
              html`<div class="text-xs text-base-content/60 mt-1">Paused at ${snapshotMeta}</div>`}
            ${filteredEvents.length === 0 &&
              html`<div class="flex flex-col items-center justify-center py-6 text-base-content/50">
                <div class="text-2xl mb-1">🛰️</div>
                <div class="text-xs">
                  ${toolEvents.length === 0 ? "No tool events yet" : "No events match filters"}
                </div>
              </div>`}
            ${filteredEvents.length > 0 &&
              html`<div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
                ${filteredEvents.map((evt) => html`
                  <div class="p-2 rounded bg-base-300 text-xs" key=${evt._id}>
                    <div class="flex items-center gap-2">
                      <span class="badge badge-xs ${evt.type === 'error' ? 'badge-error' : evt.type === 'tool_result' ? 'badge-success' : 'badge-info'}">
                        ${toolLabel(evt.type)}
                      </span>
                      ${evt.tool && html`<span class="font-mono truncate">${evt.tool}</span>`}
                      ${evt.timestamp && html`<span class="text-base-content/50 ml-auto text-[10px]">${formatRelative(evt.timestamp)}</span>`}
                    </div>
                    ${evt.content && html`<div class="text-base-content/70 mt-1 break-words">${truncate(evt.content, 260)}</div>`}
                  </div>
                `)}
              </div>`}
          </div>
        </div>
      `;
    };

    const renderFileAccess = () => {
      if (!sessionInfo && !fileAccess && !liveFileAccess) return null;
      const summarySource = (streamPaused ? streamSnapshot.fileAccess : liveFileAccess) || fileAccess;
      const summaryCounts = summarySource?.counts || {};
      const summaryFiles = summarySource?.files || [];
      const counts = {
        read: summaryCounts.read ?? summaryFiles.filter((f) => f.kinds?.includes("read")).length,
        write: summaryCounts.write ?? summaryFiles.filter((f) => f.kinds?.includes("write")).length,
        other: summaryCounts.other ?? summaryFiles.filter((f) => f.kinds?.includes("other")).length,
      };
      const search = fileSearch.trim().toLowerCase();
      const filteredFiles = summaryFiles.filter((entry) => {
        if (fileFilter !== "all" && !entry.kinds?.includes(fileFilter)) return false;
        if (!search) return true;
        return entry.path?.toLowerCase().includes(search);
      });
      const exportText = filteredFiles.map((entry) => {
        const kinds = entry.kinds?.length ? ` (${entry.kinds.join(", ")})` : "";
        return `${entry.path}${kinds}`;
      }).join("\n");
      return html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1">File Access</div>
            <div class="flex flex-wrap items-center gap-2 mb-2">
              <div class="flex flex-wrap gap-1">
                <button
                  class="btn btn-xs ${fileFilter === "all" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setFileFilter("all")}
                >
                  All (${summaryFiles.length})
                </button>
                <button
                  class="btn btn-xs ${fileFilter === "read" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setFileFilter("read")}
                >
                  Read (${counts.read})
                </button>
                <button
                  class="btn btn-xs ${fileFilter === "write" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setFileFilter("write")}
                >
                  Write (${counts.write})
                </button>
                <button
                  class="btn btn-xs ${fileFilter === "other" ? "btn-primary" : "btn-ghost"}"
                  onClick=${() => setFileFilter("other")}
                >
                  Other (${counts.other})
                </button>
              </div>
              <div class="flex items-center gap-1 ml-auto">
                <div class="join">
                  <span class="icon-inline">${ICONS.search}</span>
                  <input
                    class="input input-bordered input-sm"
                    placeholder="Filter files..."
                    value=${fileSearch}
                    onInput=${(e) => setFileSearch(e.target.value)}
                  />
                </div>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => copyToClipboard(exportText, "File list copied")}
                  disabled=${filteredFiles.length === 0}
                >
                  <span class="icon-inline">${ICONS.copy}</span> Copy
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => downloadText(
                    `file-access-${agent.taskId || agent.branch || "agent"}.txt`,
                    exportText,
                  )}
                  disabled=${filteredFiles.length === 0}
                >
                  <span class="icon-inline">${ICONS.download}</span> Export
                </button>
              </div>
            </div>
            <div class="text-xs text-base-content/60">
              ${counts.read} read · ${counts.write} written · ${counts.other} other
            </div>
            ${streamPaused && snapshotMeta &&
              html`<div class="text-xs text-base-content/60 mt-1">Paused at ${snapshotMeta}</div>`}
            ${filteredFiles.length === 0 &&
              html`<div class="flex flex-col items-center justify-center py-6 text-base-content/50">
                <div class="text-2xl mb-1">📂</div>
                <div class="text-xs">
                  ${summaryFiles.length === 0 ? "No file access recorded" : "No files match filters"}
                </div>
              </div>`}
            ${filteredFiles.length > 0 &&
              html`<div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
                ${filteredFiles.map((entry) => html`
                  <div class="p-2 rounded bg-base-300 text-xs" key=${entry.path}>
                    <div class="flex items-center gap-2">
                      <span class="badge badge-xs badge-info">FILE</span>
                      <span class="font-mono truncate">${entry.path}</span>
                    </div>
                    ${entry.kinds?.length &&
                      html`<div class="text-base-content/70 mt-1">Access: ${entry.kinds.join(", ")}</div>`}
                  </div>
                `)}
              </div>`}
          </div>
        </div>
      `;
    };

    const files = ctx?.changedFiles || [];
    const commits = ctx?.recentCommits || [];
    const aheadBehind = ctx?.gitAheadBehind || "";
    return html`
      <div class="flex flex-col gap-2 overflow-auto p-2">
        ${ctx && html`
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Branch</div>
              <div class="text-xs text-base-content/60">${ctx.gitBranch || agent.branch || "unknown"}</div>
              <div class="text-xs text-base-content/60 mt-1">${ctx.path || "unknown path"}</div>
              ${aheadBehind &&
                html`<div class="text-xs text-base-content/60 mt-1">Ahead/Behind: ${aheadBehind}</div>`}
            </div>
          </div>
        `}
        ${sessionInfo && html`
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Session</div>
              <div class="text-xs text-base-content/60">
                <span class="font-mono">${sessionInfo.id || sessionInfo.taskId}</span>
                ${sessionInfo.status ? ` · ${sessionInfo.status}` : ""}
              </div>
              ${sessionInfo.lastActiveAt &&
                html`<div class="text-xs text-base-content/60 mt-1">Last Active: ${sessionInfo.lastActiveAt}</div>`}
              ${sessionInfo.preview &&
                html`<div class="text-xs text-base-content/60 mt-1">${truncate(sessionInfo.preview, 140)}</div>`}
              <button class="btn btn-ghost btn-sm mt-2" onClick=${() => setActiveTab("stream")}>
                💬 View Stream
              </button>
            </div>
          </div>
        `}
        ${slotInfo && html`
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Active Slot</div>
              <div class="text-xs text-base-content/60">
                ${slotInfo.taskTitle || slotInfo.taskId || "slot"}
                ${slotInfo.status ? ` · ${slotInfo.status}` : ""}
              </div>
              ${slotInfo.branch &&
                html`<div class="text-xs text-base-content/60 mt-1">Branch: ${slotInfo.branch}</div>`}
            </div>
          </div>
        `}
        ${renderActionHistory()}
        ${renderLiveToolEvents()}
        ${renderFileAccess()}
        ${renderMatchList("Worktree Matches", matches.worktrees, (wt) =>
          html`<span class="font-mono">${wt.name || wt.branch || "worktree"}</span> ${wt.path ? `· ${wt.path}` : ""}`)}
        ${renderMatchList("Slot Matches", matches.slots, (slot) =>
          html`<span class="font-mono">${slot.taskId || slot.taskTitle || "slot"}</span> ${slot.branch ? `· ${slot.branch}` : ""}`)}
        ${renderMatchList("Session Matches", matches.sessions, (sess) =>
          html`<span class="font-mono">${sess.id || sess.taskId || "session"}</span> ${sess.status ? `· ${sess.status}` : ""}`)}
        ${commits.length > 0 &&
        html`
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Recent Commits</div>
              ${commits.map(
                (cm) => html`
                  <div class="text-xs text-base-content/60" key=${cm.hash}>
                    <span class="font-mono">${cm.hash}</span> ${cm.message || ""} ${cm.time ? `· ${cm.time}` : ""}
                  </div>
                `,
              )}
            </div>
          </div>
        `}
        ${ctx && html`
          <div class="card bg-base-200 shadow-sm mb-2">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Changed Files</div>
              ${files.length === 0 &&
              html`<div class="text-xs text-base-content/60">Clean working tree</div>`}
              ${files.map(
                (f) => html`
                  <div class="text-xs text-base-content/60" key=${f.file}>
                    <span class="font-mono">${f.code}</span> ${f.file}
                  </div>
                `,
              )}
            </div>
          </div>
        `}
        ${ctx?.diffSummary &&
        html`
          <div class="card bg-base-200 shadow-sm">
            <div class="card-body p-3">
              <div class="font-semibold text-sm mb-1">Diff Summary</div>
              <pre class="font-mono text-xs whitespace-pre-wrap">${ctx.diffSummary}</pre>
            </div>
          </div>
        `}
      </div>
    `;
  };

  return html`
    <div class="modal modal-open" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-box max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between mb-2">
          <div>
            <div class="font-semibold text-sm flex items-center gap-1">
              <${StatusDot} status=${agent.status || "busy"} />
              <span class="truncate">${agent.taskTitle || "(no title)"}</span>
            </div>
            <div class="text-xs text-base-content/60 truncate">
              ${agent.branch || "?"} · Slot ${(agent.index ?? 0) + 1} · ${formatDuration(agent.startedAt)}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" onClick=${onClose}>✕</button>
        </div>
        <div class="tabs tabs-boxed mb-2">
          <button
            class="tab ${activeTab === "stream" ? "tab-active" : ""}"
            onClick=${() => setActiveTab("stream")}
          >💬 Stream</button>
          <button
            class="tab ${activeTab === "changes" ? "tab-active" : ""}"
            onClick=${() => setActiveTab("changes")}
          >📝 Changes</button>
          <button
            class="tab ${activeTab === "logs" ? "tab-active" : ""}"
            onClick=${() => setActiveTab("logs")}
          >📄 Logs</button>
        </div>

          ${activeTab === "stream" &&
          html`
            ${sessionId
              ? html`<${ChatView} sessionId=${sessionId} readOnly=${true} />`
              : html`
                  <div class="flex flex-col items-center justify-center py-8">
                    <div class="text-3xl mb-2">💬</div>
                    <div class="text-sm text-base-content/60">No session stream available</div>
                  </div>
                `}
          `}
          ${activeTab === "changes" && renderChanges()}
          ${activeTab === "logs" &&
          html`<div class="bg-base-300 rounded-box p-2 font-mono text-xs overflow-auto max-h-96 whitespace-pre-wrap" ref=${logRef}>${logText}</div>`}

          <div class="flex gap-2 items-center mt-2">
            <input
              class="input input-bordered input-sm flex-1"
              placeholder="Steer agent…"
              value=${steerInput}
              onInput=${(e) => setSteerInput(e.target.value)}
              onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); handleSteer(); } }}
            />
            <button class="btn btn-primary btn-sm" onClick=${handleSteer}>🎯</button>
            <button
              class="btn btn-error btn-sm"
              disabled=${agent.index == null}
              onClick=${handleStop}
            >⛔ Stop</button>
          </div>
      </div>
    </div>
  `;
}

/* ─── Dispatch Section ─── */
function DispatchSection({ freeSlots, inputRef, className = "" }) {
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dispatching, setDispatching] = useState(false);

  const canDispatch = freeSlots > 0 && (taskId.trim() || prompt.trim());

  const handleDispatch = async () => {
    if (!canDispatch || dispatching) return;
    haptic();
    setDispatching(true);
    try {
      const body = taskId.trim()
        ? { taskId: taskId.trim() }
        : { prompt: prompt.trim() };
      const res = await apiFetch("/api/executor/dispatch", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.ok !== false) {
        showToast(`Dispatched to slot ${(res.slotIndex ?? 0) + 1}`, "success");
        setTaskId("");
        setPrompt("");
        scheduleRefresh(200);
      }
    } catch {
      /* toast via apiFetch */
    } finally {
      setDispatching(false);
    }
  };

  return html`
    <${Card}
      title="Dispatch"
      subtitle="Start a slot with a task ID or a focused prompt"
      className=${className}
    >
      <div class="flex flex-col gap-2">
        <div class="text-xs text-base-content/60">
          ${freeSlots > 0
            ? `${freeSlots} slot${freeSlots > 1 ? "s" : ""} available`
            : "No free slots"}
        </div>
        <input
          class="input input-bordered input-sm w-full"
          placeholder="Task ID"
          value=${taskId}
          ref=${inputRef}
          onInput=${(e) => { setTaskId(e.target.value); if (e.target.value) setPrompt(""); }}
        />
        <div class="divider text-xs my-0">or</div>
        <textarea
          class="textarea textarea-bordered textarea-sm w-full"
          placeholder="Freeform prompt…"
          rows="2"
          value=${prompt}
          onInput=${(e) => { setPrompt(e.target.value); if (e.target.value) setTaskId(""); }}
        />
        <button
          class="btn btn-primary btn-sm"
          disabled=${!canDispatch || dispatching}
          onClick=${handleDispatch}
        >
          ${dispatching ? "Dispatching…" : "🚀 Dispatch"}
        </button>
      </div>
    <//>
  `;
}

/* ─── AgentsTab ─── */
export function AgentsTab() {
  const executor = executorData.value;
  const agents = agentsData?.value || [];
  const execData = executor?.data;
  const slots = execData?.slots || [];
  const maxParallel = execData?.maxParallel || 0;
  const activeSlots = execData?.activeSlots || 0;

  const [expandedSlot, setExpandedSlot] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [isCompact, setIsCompact] = useState(() => {
    try { return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false; }
    catch { return false; }
  });
  const dispatchInputRef = useRef(null);
  const workspaceTarget = agentWorkspaceTarget.value;

  useEffect(() => {
    const current = selectedSessionId.value;
    const sessions = sessionsData.value || [];
    if (current || sessions.length === 0) return;
    const activeSession =
      sessions.find((s) => s.status === "active" || s.status === "running") ||
      sessions[0];
    if (activeSession?.id) {
      selectedSessionId.value = activeSession.id;
    }
  }, [sessionsData.value, selectedSessionId.value]);

  useEffect(() => {
    if (!workspaceTarget) return;
    const slotIndex = slots.findIndex((s) => {
      const targetTask = workspaceTarget.taskId || "";
      const targetBranch = workspaceTarget.branch || "";
      return (
        (targetTask && s.taskId === targetTask) ||
        (targetBranch && s.branch === targetBranch)
      );
    });
    if (slotIndex >= 0) {
      setSelectedAgent({ ...slots[slotIndex], index: slotIndex });
    } else {
      setSelectedAgent({
        taskId: workspaceTarget.taskId || null,
        taskTitle: workspaceTarget.taskTitle || workspaceTarget.branch || "Workspace",
        branch: workspaceTarget.branch || null,
        status: "idle",
        index: null,
      });
    }
    agentWorkspaceTarget.value = null;
  }, [workspaceTarget, slots]);

  useEffect(() => {
    let mq;
    try { mq = globalThis.matchMedia?.("(max-width: 768px)"); }
    catch { mq = null; }
    if (!mq) return undefined;
    const handler = (event) => setIsCompact(event.matches);
    handler(mq);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  /* Navigate to logs tab with agent query pre-filled */
  const viewAgentLogs = (query) => {
    haptic();
    if (agentLogQuery) agentLogQuery.value = query;
    if (agentLogFile) agentLogFile.value = "";
    navigateTo("logs");
  };

  /* Force stop a specific agent slot */
  const handleForceStop = async (slot) => {
    const ok = await showConfirm(
      `Force-stop agent working on "${truncate(slot.taskTitle || slot.taskId || "task", 40)}"?`,
    );
    if (!ok) return;
    haptic("heavy");
    try {
      await apiFetch("/api/executor/stop-slot", {
        method: "POST",
        body: JSON.stringify({ slotIndex: slot.index, taskId: slot.taskId }),
      });
      showToast("Stop signal sent", "success");
      scheduleRefresh(200);
    } catch {
      /* toast via apiFetch */
    }
  };

  /* Toggle expanded detail view for a slot */
  const toggleExpand = (i) => {
    haptic();
    setExpandedSlot(expandedSlot === i ? null : i);
  };

  /* Open workspace viewer for an agent */
  const openWorkspace = (slot, i) => {
    haptic();
    setSelectedAgent({ ...slot, index: i });
  };

  /* Capacity utilisation */
  const freeSlots = Math.max(0, maxParallel - activeSlots);
  const capacityPct =
    maxParallel > 0 ? Math.round((activeSlots / maxParallel) * 100) : 0;

  /* Aggregate stats */
  const totalCompleted = slots.reduce((n, s) => n + (s.completedCount || 0), 0);
  const avgTimeMs = slots.length
    ? slots.reduce((n, s) => n + (s.avgDurationMs || 0), 0) / slots.length
    : 0;
  const avgTimeStr = avgTimeMs > 0 ? `${Math.round(avgTimeMs / 1000)}s` : "—";

  /* Status counts and health summary */
  const statusCounts = slots.reduce(
    (acc, slot) => {
      const status = String(slot.status || "busy").toLowerCase();
      if (status === "busy" || status === "running") acc.running += 1;
      else if (status === "error") acc.error += 1;
      else if (status === "done") acc.done += 1;
      else if (status === "idle") acc.idle += 1;
      else acc.other += 1;
      return acc;
    },
    { running: 0, error: 0, done: 0, idle: 0, other: 0 },
  );
  const idleSlots = Math.max(0, maxParallel - activeSlots);
  const healthLabel =
    statusCounts.error > 0
      ? "Needs Attention"
      : activeSlots > 0
        ? "Healthy"
        : "Idle";
  const healthColor =
    statusCounts.error > 0
      ? "var(--color-error)"
      : activeSlots > 0
        ? "var(--color-done)"
        : "var(--text-secondary)";
  const healthSubtext =
    statusCounts.error > 0
      ? `${statusCounts.error} slot${statusCounts.error === 1 ? "" : "s"} reporting errors`
      : activeSlots > 0
        ? `${statusCounts.running || activeSlots} active · ${idleSlots} idle`
        : "No active workloads";
  const lastErrorSlot = slots.find((slot) => slot.lastError);
  const fleetMetrics = [
    { label: "Active", value: activeSlots },
    { label: "Idle", value: idleSlots },
    { label: "Errors", value: statusCounts.error },
    { label: "Completed", value: totalCompleted },
    { label: "Avg Time", value: avgTimeStr },
  ];

  const handleFleetRefresh = () => {
    haptic();
    refreshTab("agents", { force: true });
  };

  const handleFocusDispatch = () => {
    haptic();
    if (dispatchInputRef.current) {
      dispatchInputRef.current.focus();
      dispatchInputRef.current.select?.();
    }
  };

  /* Loading state */
  if (!executor && !agents.length)
    return html`<${Card} title="Loading…"><${SkeletonCard} count=${3} /><//>`;

  return html`
    <div class="flex flex-col gap-3 max-w-7xl mx-auto">
      <div class="w-full">
        <${Card}
          title="Fleet Overview"
          subtitle="Capacity, health, and quick actions"
          className="fleet-overview-card"
        >
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div class="text-xs font-semibold uppercase text-base-content/50">Health</div>
              <div class="flex items-center gap-2 text-lg font-bold">
                <span
                  class="w-3 h-3 rounded-full inline-block"
                  style=${`background:${healthColor}`}
                ></span>
                <span>${healthLabel}</span>
              </div>
              <div class="text-xs text-base-content/60">${healthSubtext}</div>
              ${lastErrorSlot && statusCounts.error > 0 &&
              html`<div class="text-xs text-error mt-1">
                Last error: ${truncate(lastErrorSlot.lastError || "Unknown error", 90)}
              </div>`}
            </div>

            <div>
              <div class="text-xs font-semibold uppercase text-base-content/50">Capacity</div>
              <div class="text-2xl font-bold">
                ${activeSlots}
                <span class="text-base-content/40">/</span>
                ${maxParallel}
              </div>
              <div class="text-xs text-base-content/60">
                ${capacityPct}% used · ${freeSlots} free
              </div>
              <div class="mt-1">
                <${ProgressBar} percent=${capacityPct} />
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
            ${fleetMetrics.map(
              (metric) => html`
                <div class="text-center" key=${metric.label}>
                  <div class="text-xs text-base-content/50">${metric.label}</div>
                  <div class="text-lg font-bold">${metric.value}</div>
                </div>
              `,
            )}
          </div>

          <div class="flex flex-wrap gap-2 mt-3">
            <button class="btn btn-primary btn-sm" onClick=${handleFocusDispatch}>
              🚀 Dispatch
            </button>
            <button class="btn btn-secondary btn-sm" onClick=${handleFleetRefresh}>
              ↻ Refresh
            </button>
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => navigateTo("logs")}
            >
              📄 Logs
            </button>
          </div>
        <//>
      </div>

      <div class="w-full">
        <${DispatchSection}
          freeSlots=${freeSlots}
          inputRef=${dispatchInputRef}
          className="fleet-dispatch-card"
        />

        <${Card} className="fleet-slotmap-card mt-3">
          <${Collapsible} title="Slot Map" defaultOpen=${!isCompact}>
            <div class="text-xs text-base-content/60 mb-2">Tap a slot to open the workspace.</div>
            <div class="grid grid-cols-4 md:grid-cols-6 gap-1">
              ${Array.from(
                { length: Math.max(maxParallel, slots.length, 1) },
                (_, i) => {
                  const slot = slots[i];
                  const st = slot ? slot.status || "busy" : "idle";
                  return html`
                    <div
                      key=${i}
                      class="flex items-center gap-1 p-1.5 rounded cursor-pointer hover:bg-base-300 text-xs"
                      title=${slot
                        ? `${slot.taskTitle || slot.taskId} (${st})`
                        : `Slot ${i + 1} idle`}
                      onClick=${() => slot && openWorkspace(slot, i)}
                    >
                      <${StatusDot} status=${st} />
                      <span class="font-mono text-xs">${i + 1}</span>
                    </div>
                  `;
                },
              )}
            </div>
          <//>
        <//>
      </div>

      <div class="w-full">
        <${Card} className="fleet-active-card">
          <${Collapsible}
            title=${activeSlots > 0
              ? `Active Slots · ${activeSlots} active`
              : "Active Slots"}
            defaultOpen=${!isCompact}
          >
            <div class="text-xs text-base-content/60 mb-2">
              ${activeSlots > 0
                ? `${activeSlots} active · ${freeSlots} free`
                : "No active slots"}
            </div>
            ${slots.length
              ? slots.map(
                  (slot, i) => html`
                    <div
                      key=${i}
                      class="card bg-base-200 shadow-sm mb-2 ${expandedSlot === i
                        ? "ring-1 ring-primary"
                        : ""}"
                    >
                      <div class="card-body p-3">
                        <div
                          class="flex items-center justify-between cursor-pointer"
                          onClick=${() => toggleExpand(i)}
                        >
                          <div class="min-w-0">
                            <div class="font-semibold text-sm flex items-center gap-1">
                              <${StatusDot} status=${slot.status || "busy"} />
                              <span class="truncate">${slot.taskTitle || "(no title)"}</span>
                            </div>
                            <div class="text-xs text-base-content/60 truncate">
                              ${slot.taskId || "?"} · Agent
                              ${slot.agentInstanceId || "n/a"} · ${slot.sdk || "?"}${slot.model ? ` · ${slot.model}` : ""}
                            </div>
                          </div>
                          <${Badge}
                            status=${slot.status || "busy"}
                            text=${slot.status || "busy"}
                          />
                        </div>
                        <div class="flex items-center justify-between text-xs">
                          <div class="text-base-content/60">Attempt ${slot.attempt || 1}</div>
                          ${slot.startedAt && html`
                            <div class="font-mono text-base-content/60">${formatDuration(slot.startedAt)}</div>
                          `}
                        </div>

                        ${(slot.status === "running" || slot.status === "busy") &&
                      html`
                        <div class="w-full h-1 bg-base-300 rounded-full overflow-hidden mt-2">
                          <div
                            class="h-full bg-primary animate-pulse rounded-full w-1/2"
                          ></div>
                        </div>
                      `}

                      ${expandedSlot === i &&
                      html`
                        <div class="flex flex-col gap-1 mt-2">
                          ${slot.branch &&
                          html`<div class="text-xs text-base-content/60">Branch: ${slot.branch}</div>`}
                          ${slot.startedAt &&
                          html`<div class="text-xs text-base-content/60">
                            Started: ${formatRelative(slot.startedAt)}
                          </div>`}
                          ${slot.completedCount != null &&
                          html`<div class="text-xs text-base-content/60">
                            Completed: ${slot.completedCount} tasks
                          </div>`}
                          ${slot.avgDurationMs &&
                          html`<div class="text-xs text-base-content/60">
                            Avg: ${Math.round(slot.avgDurationMs / 1000)}s
                          </div>`}
                          ${slot.model &&
                          html`<div class="text-xs text-base-content/60">Model: ${slot.model}</div>`}
                          ${slot.lastError &&
                          html`<div
                            class="text-xs text-error"
                          >
                            Last error: ${truncate(slot.lastError, 100)}
                          </div>`}
                        </div>
                      `}

                      <div class="flex flex-wrap gap-1 mt-2">
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick=${() =>
                            viewAgentLogs(
                              (slot.taskId || slot.branch || "").slice(0, 12),
                            )}
                        >
                          📄 Logs
                        </button>
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick=${() =>
                            sendCommandToChat(
                              `/steer focus on ${slot.taskTitle || slot.taskId}`,
                            )}
                        >
                          🎯 Steer
                        </button>
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick=${() => openWorkspace(slot, i)}
                        >
                          🔍 View
                        </button>
                        <button
                          class="btn btn-error btn-sm"
                          onClick=${() => handleForceStop({ ...slot, index: i })}
                        >
                          ⛔ Stop
                        </button>
                      </div>
                    </div>
                  </div>
                `,
              )
            : html`<${EmptyState} message="No active agents." />`}
        <//>
      <//>
      </div>

      ${agents.length > 0 &&
      html`
        <div class="w-full">
          <${Collapsible} title="Agent Threads" defaultOpen=${false}>
            <${Card} className="fleet-threads-card">
              <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
                ${agents.map(
                  (t, i) => html`
                    <${StatCard}
                      key=${i}
                      value=${t.turnCount || 0}
                      label="${truncate(t.taskKey || `Thread ${i}`, 20)} (${t.sdk ||
                      "?"})"
                    />
                  `,
                )}
              </div>
            <//>
          <//>
        </div>
      `}

      <div class="w-full">
        <${SessionsPanel} />
      </div>
    </div>

    ${selectedAgent && html`
      <${WorkspaceViewer}
        agent=${selectedAgent}
        onClose=${() => setSelectedAgent(null)}
      />
    `}
  `;
}

/* ─── Context Viewer for session detail tab ─── */
function ContextViewer({ sessionId }) {
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const fetchContext = useCallback(() => {
    if (!sessionId) return;
    apiFetch(`/api/agent-context?query=${encodeURIComponent(sessionId)}`, { _silent: true })
      .then((res) => {
        const d = res.data ?? res ?? null;
        setCtx(d);
        setLoading(false);
        setError(null);
      })
      .catch((err) => {
        setLoading(false);
        setError(err.message || "Failed to load context");
      });
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setCtx(null);
    fetchContext();
    intervalRef.current = setInterval(fetchContext, 10000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchContext]);

  const parseCommits = (detailed) => {
    if (!detailed) return [];
    return detailed.split("\n").filter(Boolean).map((line) => {
      const parts = line.split("||");
      return { hash: parts[0] || "", message: parts[1] || "", time: parts[2] || "" };
    });
  };

  const parseStatus = (raw) => {
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const code = line.substring(0, 2).trim() || "?";
      const file = line.substring(3);
      return { code, file };
    });
  };

  const parseAheadBehind = (raw) => {
    if (!raw) return { ahead: 0, behind: 0 };
    const parts = raw.split(/\s+/);
    return { ahead: parseInt(parts[0], 10) || 0, behind: parseInt(parts[1], 10) || 0 };
  };

  const statusColor = (code) => {
    if (code === "M" || code === "MM") return "var(--color-inprogress)";
    if (code === "A") return "var(--color-done)";
    if (code === "D") return "var(--color-error)";
    if (code === "?" || code === "??") return "var(--text-secondary)";
    return "var(--text-primary)";
  };

  const statusLabel = (code) => {
    const map = { M: "Modified", MM: "Modified", A: "Added", D: "Deleted", "?": "Untracked", "??": "Untracked", R: "Renamed", C: "Copied" };
    return map[code] || code;
  };

  const copyContext = () => {
    if (!ctx?.context) return;
    const c = ctx.context;
    const ab = parseAheadBehind(c.gitAheadBehind);
    const commits = parseCommits(c.gitLogDetailed);
    const files = parseStatus(c.gitStatus);
    let text = `## Workspace Context\n`;
    text += `Branch: ${c.gitBranch || "unknown"}\n`;
    text += `Path: ${c.path || "unknown"}\n`;
    text += `Status: ${files.length === 0 ? "Clean" : `${files.length} changed file(s)`}\n`;
    if (ab.ahead || ab.behind) text += `Ahead: ${ab.ahead}, Behind: ${ab.behind}\n`;
    if (commits.length) {
      text += `\n### Recent Commits\n`;
      commits.forEach((cm) => { text += `${cm.hash} ${cm.message} (${cm.time})\n`; });
    }
    if (files.length) {
      text += `\n### Modified Files\n`;
      files.forEach((f) => { text += `[${f.code}] ${f.file}\n`; });
    }
    if (!navigator?.clipboard?.writeText) {
      showToast("Clipboard unavailable", "error");
      return;
    }
    navigator.clipboard.writeText(text).then(() => showToast("Context copied", "success")).catch(() => showToast("Copy failed", "error"));
  };

  if (loading) {
    return html`<div class="p-4">
      <${SkeletonCard} height="40px" />
      <${SkeletonCard} height="120px" className="mt-2" />
      <${SkeletonCard} height="80px" className="mt-2" />
    </div>`;
  }

  if (error) {
    return html`<div class="flex flex-col items-center justify-center py-8">
      <div class="text-3xl mb-2 text-error">⚠️</div>
      <div class="text-sm text-base-content/60">${error}</div>
      <button class="btn btn-primary btn-sm mt-2" onClick=${() => { setLoading(true); setError(null); fetchContext(); }}>🔄 Retry</button>
    </div>`;
  }

  if (!ctx?.context) {
    return html`<div class="flex flex-col items-center justify-center py-8">
      <div class="text-3xl mb-2">📋</div>
      <div class="text-sm text-base-content/60">No context available for this session</div>
    </div>`;
  }

  const c = ctx.context;
  const ab = parseAheadBehind(c.gitAheadBehind);
  const commits = parseCommits(c.gitLogDetailed);
  const files = parseStatus(c.gitStatus);
  const isDirty = files.length > 0;

  return html`
    <div class="flex flex-col gap-2 p-3 overflow-y-auto">
      <!-- Toolbar -->
      <div class="flex gap-2 justify-end mb-2">
        <button class="btn btn-ghost btn-sm" onClick=${() => { setLoading(true); fetchContext(); }}>
          <span class="icon-inline">${ICONS.refresh}</span> Refresh
        </button>
        <button class="btn btn-ghost btn-sm" onClick=${copyContext}>
          <span class="icon-inline">${ICONS.copy}</span> Copy Context
        </button>
      </div>

      <!-- Branch & Status -->
      <div class="card bg-base-200 shadow-sm mb-2">
        <div class="card-body p-3">
          <div class="font-semibold text-sm mb-1 flex items-center gap-2">
            <span class="icon-inline">${ICONS.git}</span> Branch & Status
          </div>
          <div class="flex flex-wrap gap-3 mt-2">
            <div class="flex-1 min-w-[120px]">
              <div class="text-xs text-base-content/60">Branch</div>
              <div class="font-semibold font-mono text-sm">${c.gitBranch || "unknown"}</div>
            </div>
            <div>
              <div class="text-xs text-base-content/60">Status</div>
              <${Badge}
                status=${isDirty ? "inprogress" : "done"}
                text=${isDirty ? `${files.length} changed` : "Clean"}
              />
            </div>
            ${(ab.ahead > 0 || ab.behind > 0) && html`
              <div>
                <div class="text-xs text-base-content/60">Sync</div>
                <div class="text-sm">
                  ${ab.ahead > 0 ? html`<span class="text-success">↑${ab.ahead}</span>` : null}
                  ${ab.ahead > 0 && ab.behind > 0 ? " " : null}
                  ${ab.behind > 0 ? html`<span class="text-error">↓${ab.behind}</span>` : null}
                </div>
              </div>
            `}
          </div>
        </div>
      </div>

      <!-- Working Directory -->
      <div class="card bg-base-200 shadow-sm mb-2">
        <div class="card-body p-3">
          <div class="font-semibold text-sm mb-1 flex items-center gap-2">
            <span class="icon-inline">${ICONS.folder}</span> Working Directory
          </div>
          <div class="font-mono text-xs text-base-content/60 mt-1 break-all">
            ${c.path || "unknown"}
          </div>
        </div>
      </div>

      <!-- Recent Commits -->
      ${commits.length > 0 && html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1 flex items-center gap-2">
              <span class="icon-inline">${ICONS.clock}</span> Recent Commits
            </div>
            <div class="mt-2">
              ${commits.map((cm) => html`
                <div key=${cm.hash} class="flex gap-2 items-baseline py-1 border-b border-base-300">
                  <code class="text-info text-xs shrink-0">${cm.hash}</code>
                  <span class="flex-1 text-sm truncate">${cm.message}</span>
                  <span class="text-xs text-base-content/50 shrink-0">${cm.time}</span>
                </div>
              `)}
            </div>
          </div>
        </div>
      `}

      <!-- Modified Files -->
      ${files.length > 0 && html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1 flex items-center gap-2">
              <span class="icon-inline">${ICONS.edit}</span> Modified Files
              <${Badge} text="${files.length}" className="ml-auto" />
            </div>
            <div class="mt-2">
              ${files.map((f) => html`
                <div key=${f.file} class="flex gap-2 items-center py-1 border-b border-base-300">
                  <code class="text-xs font-bold min-w-[20px] text-center" style="color:${statusColor(f.code)}" title=${statusLabel(f.code)}>${f.code}</code>
                  <span class="font-mono text-xs truncate">${f.file}</span>
                </div>
              `)}
            </div>
          </div>
        </div>
      `}

      <!-- Diff Stats -->
      ${c.gitDiffStat && html`
        <div class="card bg-base-200 shadow-sm mb-2">
          <div class="card-body p-3">
            <div class="font-semibold text-sm mb-1 flex items-center gap-2">
              <span class="icon-inline">${ICONS.terminal}</span> Diff Summary
            </div>
            <pre class="text-xs mt-2 whitespace-pre-wrap text-base-content/60 overflow-x-auto">${c.gitDiffStat}</pre>
          </div>
        </div>
      `}
    </div>
  `;
}

/* ─── Sessions Panel — split view with list + detail ─── */
function SessionsPanel() {
  const [detailTab, setDetailTab] = useState("chat");
  const sessionId = selectedSessionId.value;

  const handleBack = useCallback(() => {
    selectedSessionId.value = null;
  }, []);

  return html`
    <${Card} title="Sessions">
      <div class="flex gap-2">
        <${SessionList} onSelect=${() => setDetailTab("chat")} />
        <div class="flex-1 flex flex-col min-w-0">
          ${sessionId && html`
            <button class="btn btn-ghost btn-xs mb-1" onClick=${handleBack}>
              ← Back to sessions
            </button>
            <div class="tabs tabs-boxed mb-2">
              <button
                class="tab ${detailTab === "chat" ? "tab-active" : ""}"
                onClick=${() => setDetailTab("chat")}
              >💬 Chat</button>
              <button
                class="tab ${detailTab === "diff" ? "tab-active" : ""}"
                onClick=${() => setDetailTab("diff")}
              >📝 Diff</button>
              <button
                class="tab ${detailTab === "context" ? "tab-active" : ""}"
                onClick=${() => setDetailTab("context")}
              >📋 Context</button>
            </div>
          `}
          ${detailTab === "chat" && html`<${ChatView} sessionId=${sessionId} />`}
          ${detailTab === "diff" && sessionId && html`<${DiffViewer} sessionId=${sessionId} />`}
          ${detailTab === "context" && sessionId && html`<${ContextViewer} sessionId=${sessionId} />`}
          ${!sessionId && detailTab !== "chat" && html`
            <div class="flex flex-col items-center justify-center py-8">
              <div class="text-3xl mb-2">💬</div>
              <div class="text-sm text-base-content/60">Select a session</div>
            </div>
          `}
        </div>
      </div>
    <//>
  `;
}
