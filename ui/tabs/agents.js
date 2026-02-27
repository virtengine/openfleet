/* ─────────────────────────────────────────────────────────────
 *  Tab: Agents — thread/slot cards, capacity, detail expansion
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
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
    class="status-dot"
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

function taskSortScore(task) {
  const rawId = String(task?.id || "");
  const digits = rawId.match(/\d+/g);
  const numeric = digits?.length ? Number(digits[digits.length - 1]) : NaN;
  if (Number.isFinite(numeric)) return numeric;
  const createdAt = new Date(task?.createdAt || task?.created_at || 0).getTime();
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  return 0;
}

function formatTaskOptionLabel(task) {
  const rawId = String(task?.id || "").trim();
  const digits = rawId.match(/\d+/g);
  const numberToken = digits?.length ? digits[digits.length - 1] : rawId || "?";
  return `#${numberToken} ${task?.title || "(untitled task)"}`;
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
  const [expandedEventItems, setExpandedEventItems] = useState(() => new Set());
  const [expandedFileItems, setExpandedFileItems] = useState(() => new Set());
  const [expandedModelResponse, setExpandedModelResponse] = useState(false);
  const logRef = useRef(null);

  const query = agent.branch || agent.taskId || agent.sessionId || "";
  const linkedSession =
    (sessionsData.value || []).find((s) => {
      if (!s) return false;
      const sid = String(s.id || "");
      const taskId = String(s.taskId || "");
      const branch = String(s.branch || "");
      return (
        (agent.sessionId && sid === String(agent.sessionId)) ||
        (agent.taskId && taskId === String(agent.taskId)) ||
        (agent.branch && branch === String(agent.branch))
      );
    }) || null;
  const sessionId =
    contextData?.session?.id || agent.sessionId || linkedSession?.id || null;

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
    setExpandedEventItems(new Set());
    setExpandedFileItems(new Set());
    setExpandedModelResponse(false);
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

  const toggleExpandedEvent = useCallback((key) => {
    if (!key) return;
    setExpandedEventItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleExpandedFile = useCallback((key) => {
    if (!key) return;
    setExpandedFileItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toMultilineText = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const toSingleLinePreview = (value, limit = 220) => {
    const compact = String(value || "").replace(/\s+/g, " ").trim();
    if (!compact) return "";
    return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
  };

  const isModelResponseMessage = (msg) => {
    if (!msg) return false;
    const role = String(msg.role || "").toLowerCase();
    const type = String(msg.type || "").toLowerCase();
    if (role === "assistant") return true;
    if (
      type === "agent_message" ||
      type === "assistant" ||
      type === "assistant_message"
    ) {
      return true;
    }
    if (role) return false;
    if (!msg.content) return false;
    return ![
      "tool_call",
      "tool_result",
      "tool_output",
      "error",
      "stream_error",
      "system",
      "user",
    ].includes(type);
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
    const latestModelResponse =
      streamMessages
        .slice()
        .reverse()
        .find((msg) => isModelResponseMessage(msg)) || null;
    const latestModelResponseText = latestModelResponse
      ? toMultilineText(latestModelResponse.content || "")
      : "";
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
        <div class="card mb-sm">
          <div class="card-title">${title}</div>
          ${items.map((item, i) => html`
            <div class="meta-text" key=${i}>
              ${renderItem(item)}
            </div>
          `)}
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
        <div class="workspace-context">
          <div class="card mb-sm">
            <div class="card-title">Workspace Context Unavailable</div>
            <div class="meta-text">Query: ${contextData?.query || query || "unknown"}</div>
            ${reasons.length > 0 &&
              html`<div class="meta-text mt-xs">
                ${reasons.map((r) => formatReason(r)).join(" ")}
              </div>`}
            ${hints.length > 0 &&
              html`<div class="meta-text mt-xs">
                ${hints.join(" ")}
              </div>`}
            ${(diagnostics?.searched?.activeSlots != null ||
              diagnostics?.searched?.activeWorktrees != null ||
              diagnostics?.searched?.sessions != null) &&
              html`<div class="meta-text mt-xs">
                Searched: ${diagnostics?.searched?.activeSlots ?? 0} slots · ${diagnostics?.searched?.activeWorktrees ?? 0} worktrees · ${diagnostics?.searched?.sessions ?? 0} sessions
              </div>`}
          </div>

          ${renderMatchList("Worktree Matches", matches.worktrees, (wt) =>
            html`<span class="mono">${wt.name || wt.branch || "worktree"}</span> ${wt.path ? `· ${wt.path}` : ""}`)}
          ${renderMatchList("Slot Matches", matches.slots, (slot) =>
            html`<span class="mono">${slot.taskId || slot.taskTitle || "slot"}</span> ${slot.branch ? `· ${slot.branch}` : ""}`)}
          ${renderMatchList("Session Matches", matches.sessions, (sess) =>
            html`<span class="mono">${sess.id || sess.taskId || "session"}</span> ${sess.status ? `· ${sess.status}` : ""}`)}

          ${sessionInfo && html`
            <div class="card mb-sm">
              <div class="card-title">Session</div>
              <div class="meta-text">
                <span class="mono">${sessionInfo.id || sessionInfo.taskId}</span>
                ${sessionInfo.status ? ` · ${sessionInfo.status}` : ""}
              </div>
              ${sessionInfo.preview &&
                html`<div class="meta-text mt-xs">${truncate(sessionInfo.preview, 120)}</div>`}
              <button class="btn btn-ghost btn-sm mt-sm" onClick=${() => setActiveTab("stream")}>
                ${iconText("💬 View Stream")}
              </button>
            </div>
          `}
        </div>
      `;
    }

    const renderActionHistory = () => {
      if (!sessionInfo && actionHistory.length === 0) return null;
      return html`
        <div class="card mb-sm">
          <div class="card-title">Action History</div>
          ${actionHistory.length === 0 &&
            html`<div class="meta-text">No recent tool actions recorded</div>`}
          ${actionHistory.map((action, i) => {
            const label =
              action.type === "tool_result"
                ? "RESULT"
                : action.tool || "TOOL";
            const detail = action.detail || action.content || "";
            return html`
              <div class="meta-text" key=${i}>
                <span class="mono">${label}</span>
                ${detail ? ` ${truncate(detail, 140)}` : ""}
                ${action.timestamp ? ` · ${formatRelative(action.timestamp)}` : ""}
              </div>
            `;
          })}
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
        <div class="card mb-sm">
          <div class="card-title">Live Tool/Event Stream</div>
          <div class="stream-toolbar">
            <div class="chip-group stream-chips">
              <button
                class="chip ${streamFilter === "all" ? "active" : ""}"
                onClick=${() => setStreamFilter("all")}
              >
                All (${counts.all})
              </button>
              <button
                class="chip ${streamFilter === "tool" ? "active" : ""}"
                onClick=${() => setStreamFilter("tool")}
              >
                Tool (${counts.tool})
              </button>
              <button
                class="chip ${streamFilter === "result" ? "active" : ""}"
                onClick=${() => setStreamFilter("result")}
              >
                Result (${counts.result})
              </button>
              <button
                class="chip ${streamFilter === "error" ? "active" : ""}"
                onClick=${() => setStreamFilter("error")}
              >
                Error (${counts.error})
              </button>
            </div>
            <div class="stream-actions">
              <div class="stream-search">
                <span class="icon-inline">${ICONS.search}</span>
                <input
                  class="input input-compact"
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
            html`<div class="meta-text mt-xs">Paused at ${snapshotMeta}</div>`}
          ${latestModelResponseText &&
            html`
              <div class="stream-final-response ${expandedModelResponse ? "expanded" : ""}">
                <button
                  class="stream-item-toggle stream-item-toggle-final"
                  type="button"
                  onClick=${() => setExpandedModelResponse((prev) => !prev)}
                >
                  <div class="stream-item-header">
                    <span class="stream-tag stream-tag-model">MODEL</span>
                    <span class="stream-item-title">Latest model response</span>
                    ${latestModelResponse?.timestamp &&
                      html`<span class="stream-item-time">
                        ${formatRelative(latestModelResponse.timestamp)}
                      </span>`}
                  </div>
                  <div class="stream-item-preview">
                    ${toSingleLinePreview(latestModelResponseText, 260)}
                  </div>
                  <span class="stream-item-chevron">${expandedModelResponse ? "▾" : "▸"}</span>
                </button>
                <div class="stream-item-details ${expandedModelResponse ? "expanded" : ""}">
                  <div class="stream-item-details-inner">
                    <pre class="stream-item-pre">${latestModelResponseText}</pre>
                  </div>
                </div>
              </div>
            `}
          ${filteredEvents.length === 0 &&
            html`<div class="stream-empty">
              <div class="stream-empty-icon">${resolveIcon("🛰")}</div>
              <div class="stream-empty-text">
                ${toolEvents.length === 0 ? "No tool events yet" : "No events match filters"}
              </div>
            </div>`}
          ${filteredEvents.length > 0 &&
            html`<div class="stream-list">
              ${filteredEvents.map((evt) => {
                const rowKey = evt._id;
                const bodyText = toMultilineText(evt.content || evt.detail || "");
                const hasBody = bodyText.trim().length > 0;
                const expanded = rowKey ? expandedEventItems.has(rowKey) : false;
                return html`
                  <div class="stream-item stream-${evt.type} ${expanded ? "expanded" : ""}" key=${rowKey}>
                    <button
                      class="stream-item-toggle"
                      type="button"
                      onClick=${() => hasBody && toggleExpandedEvent(rowKey)}
                      disabled=${!hasBody}
                    >
                      <div class="stream-item-header">
                        <span class="stream-tag stream-tag-${evt.type}">
                          ${toolLabel(evt.type)}
                        </span>
                        ${evt.tool && html`<span class="stream-item-tool mono">${evt.tool}</span>`}
                        <span class="stream-item-title">
                          ${toSingleLinePreview(bodyText, 240) || "No details"}
                        </span>
                        ${evt.timestamp && html`<span class="stream-item-time">${formatRelative(evt.timestamp)}</span>`}
                      </div>
                      ${hasBody && html`<span class="stream-item-chevron">${expanded ? "▾" : "▸"}</span>`}
                    </button>
                    ${hasBody && html`
                      <div class="stream-item-details ${expanded ? "expanded" : ""}">
                        <div class="stream-item-details-inner ${bodyText.length > 1600 ? "stream-item-details-scroll" : ""}">
                          <pre class="stream-item-pre">${bodyText}</pre>
                        </div>
                      </div>
                    `}
                  </div>
                `;
              })}
            </div>`}
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
        <div class="card mb-sm">
          <div class="card-title">File Access</div>
          <div class="stream-toolbar">
            <div class="chip-group stream-chips">
              <button
                class="chip ${fileFilter === "all" ? "active" : ""}"
                onClick=${() => setFileFilter("all")}
              >
                All (${summaryFiles.length})
              </button>
              <button
                class="chip ${fileFilter === "read" ? "active" : ""}"
                onClick=${() => setFileFilter("read")}
              >
                Read (${counts.read})
              </button>
              <button
                class="chip ${fileFilter === "write" ? "active" : ""}"
                onClick=${() => setFileFilter("write")}
              >
                Write (${counts.write})
              </button>
              <button
                class="chip ${fileFilter === "other" ? "active" : ""}"
                onClick=${() => setFileFilter("other")}
              >
                Other (${counts.other})
              </button>
            </div>
            <div class="stream-actions">
              <div class="stream-search">
                <span class="icon-inline">${ICONS.search}</span>
                <input
                  class="input input-compact"
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
          <div class="meta-text">
            ${counts.read} read · ${counts.write} written · ${counts.other} other
          </div>
          ${streamPaused && snapshotMeta &&
            html`<div class="meta-text mt-xs">Paused at ${snapshotMeta}</div>`}
          ${filteredFiles.length === 0 &&
            html`<div class="stream-empty">
              <div class="stream-empty-icon">${resolveIcon("📂")}</div>
              <div class="stream-empty-text">
                ${summaryFiles.length === 0 ? "No file access recorded" : "No files match filters"}
              </div>
            </div>`}
          ${filteredFiles.length > 0 &&
            html`<div class="stream-list">
              ${filteredFiles.map((entry) => {
                const rowKey = `${entry.path || "unknown"}::${(entry.kinds || []).join(",")}`;
                const expanded = expandedFileItems.has(rowKey);
                const details = [
                  `Path: ${entry.path || "unknown"}`,
                  entry.kinds?.length
                    ? `Access kinds: ${entry.kinds.join(", ")}`
                    : "Access kinds: unknown",
                ].join("\n");
                return html`
                  <div class="stream-item stream-file ${expanded ? "expanded" : ""}" key=${rowKey}>
                    <button
                      class="stream-item-toggle"
                      type="button"
                      onClick=${() => toggleExpandedFile(rowKey)}
                    >
                      <div class="stream-item-header">
                        <span class="stream-tag stream-tag-file">FILE</span>
                        <span class="stream-item-title mono">${entry.path}</span>
                      </div>
                      <span class="stream-item-chevron">${expanded ? "▾" : "▸"}</span>
                    </button>
                    <div class="stream-item-details ${expanded ? "expanded" : ""}">
                      <div class="stream-item-details-inner">
                        <pre class="stream-item-pre">${details}</pre>
                      </div>
                    </div>
                  </div>
                `;
              })}
            </div>`}
        </div>
      `;
    };

    const files = ctx?.changedFiles || [];
    const commits = ctx?.recentCommits || [];
    const aheadBehind = ctx?.gitAheadBehind || "";
    return html`
      <div class="workspace-context">
        ${ctx && html`
          <div class="card mb-sm">
            <div class="card-title">Branch</div>
            <div class="meta-text">${ctx.gitBranch || agent.branch || "unknown"}</div>
            <div class="meta-text mt-xs">${ctx.path || "unknown path"}</div>
            ${aheadBehind &&
              html`<div class="meta-text mt-xs">Ahead/Behind: ${aheadBehind}</div>`}
          </div>
        `}
        ${sessionInfo && html`
          <div class="card mb-sm">
            <div class="card-title">Session</div>
            <div class="meta-text">
              <span class="mono">${sessionInfo.id || sessionInfo.taskId}</span>
              ${sessionInfo.status ? ` · ${sessionInfo.status}` : ""}
            </div>
            ${sessionInfo.lastActiveAt &&
              html`<div class="meta-text mt-xs">Last Active: ${sessionInfo.lastActiveAt}</div>`}
            ${sessionInfo.preview &&
              html`<div class="meta-text mt-xs">${truncate(sessionInfo.preview, 140)}</div>`}
            <button class="btn btn-ghost btn-sm mt-sm" onClick=${() => setActiveTab("stream")}>
              ${iconText("💬 View Stream")}
            </button>
          </div>
        `}
        ${slotInfo && html`
          <div class="card mb-sm">
            <div class="card-title">Active Slot</div>
            <div class="meta-text">
              ${slotInfo.taskTitle || slotInfo.taskId || "slot"}
              ${slotInfo.status ? ` · ${slotInfo.status}` : ""}
            </div>
            ${slotInfo.branch &&
              html`<div class="meta-text mt-xs">Branch: ${slotInfo.branch}</div>`}
          </div>
        `}
        ${renderActionHistory()}
        ${renderLiveToolEvents()}
        ${renderFileAccess()}
        ${renderMatchList("Worktree Matches", matches.worktrees, (wt) =>
          html`<span class="mono">${wt.name || wt.branch || "worktree"}</span> ${wt.path ? `· ${wt.path}` : ""}`)}
        ${renderMatchList("Slot Matches", matches.slots, (slot) =>
          html`<span class="mono">${slot.taskId || slot.taskTitle || "slot"}</span> ${slot.branch ? `· ${slot.branch}` : ""}`)}
        ${renderMatchList("Session Matches", matches.sessions, (sess) =>
          html`<span class="mono">${sess.id || sess.taskId || "session"}</span> ${sess.status ? `· ${sess.status}` : ""}`)}
        ${commits.length > 0 &&
        html`
          <div class="card mb-sm">
            <div class="card-title">Recent Commits</div>
            ${commits.map(
              (cm) => html`
                <div class="meta-text" key=${cm.hash}>
                  <span class="mono">${cm.hash}</span> ${cm.message || ""} ${cm.time ? `· ${cm.time}` : ""}
                </div>
              `,
            )}
          </div>
        `}
        ${ctx && html`
          <div class="card mb-sm">
            <div class="card-title">Changed Files</div>
            ${files.length === 0 &&
            html`<div class="meta-text">Clean working tree</div>`}
            ${files.map(
              (f) => html`
                <div class="meta-text" key=${f.file}>
                  <span class="mono">${f.code}</span> ${f.file}
                </div>
              `,
            )}
          </div>
        `}
        ${ctx?.diffSummary &&
        html`
          <div class="card">
            <div class="card-title">Diff Summary</div>
            <pre class="workspace-diff">${ctx.diffSummary}</pre>
          </div>
        `}
      </div>
    `;
  };

  return html`
    <div class="modal-overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-content modal-content-wide workspace-modal-content">
        <div class="modal-handle" />
        <div class="workspace-viewer">
          <div class="workspace-header">
            <div>
              <div class="task-card-title">
                <${StatusDot} status=${agent.status || "busy"} />
                ${agent.taskTitle || "(no title)"}
              </div>
              <div class="task-card-meta">
                ${agent.branch || "?"} · Slot ${(agent.index ?? 0) + 1} · ${formatDuration(agent.startedAt)}
              </div>
            </div>
            <button class="btn btn-ghost btn-sm" onClick=${onClose}>${resolveIcon("✕")}</button>
          </div>
          <div class="session-detail-tabs workspace-tabs">
            <button
              class="session-detail-tab ${activeTab === "stream" ? "active" : ""}"
              onClick=${() => setActiveTab("stream")}
            >${iconText("💬 Stream")}</button>
            <button
              class="session-detail-tab ${activeTab === "changes" ? "active" : ""}"
              onClick=${() => setActiveTab("changes")}
            >${iconText("📝 Changes")}</button>
            <button
              class="session-detail-tab ${activeTab === "logs" ? "active" : ""}"
              onClick=${() => setActiveTab("logs")}
            >${iconText("📄 Logs")}</button>
          </div>

          <div class="workspace-body">
            ${activeTab === "stream" &&
            html`
              ${sessionId
                ? html`<${ChatView} sessionId=${sessionId} readOnly=${true} />`
                : html`
                    <div class="chat-view chat-empty-state">
                      <div class="session-empty-icon">${resolveIcon("💬")}</div>
                      <div class="session-empty-text">No session stream available</div>
                    </div>
                  `}
            `}
            ${activeTab === "changes" && renderChanges()}
            ${activeTab === "logs" &&
            html`<div class="workspace-log" ref=${logRef}>${logText}</div>`}
          </div>

          <div class="workspace-controls">
            <input
              class="input"
              placeholder="Steer agent…"
              value=${steerInput}
              onInput=${(e) => setSteerInput(e.target.value)}
              onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); handleSteer(); } }}
            />
            <button class="btn btn-primary btn-sm" onClick=${handleSteer}>${resolveIcon("🎯")}</button>
            <button
              class="btn btn-danger btn-sm"
              disabled=${agent.index == null}
              onClick=${handleStop}
            >${iconText("⛔ Stop")}</button>
          </div>
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
  const [taskChoices, setTaskChoices] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  const canDispatch = Boolean(taskId.trim() || prompt.trim());

  const loadDispatchTasks = useCallback(() => {
    setTasksLoading(true);
    apiFetch("/api/tasks?limit=1000", { _silent: true })
      .then((res) => {
        const tasks = Array.isArray(res?.data) ? res.data : [];
        const choices = tasks
          .filter((task) => {
            const status = String(task?.status || "").toLowerCase();
            return task?.draft === true || status === "draft" || status === "todo";
          })
          .sort((a, b) => taskSortScore(b) - taskSortScore(a));
        setTaskChoices(choices);
      })
      .catch(() => {
        setTaskChoices([]);
      })
      .finally(() => {
        setTasksLoading(false);
      });
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      loadDispatchTasks();
    };
    tick();
    const interval = setInterval(tick, 12000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [loadDispatchTasks]);

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
        showToast("Dispatch started", "success");
        setTaskId("");
        setPrompt("");
        loadDispatchTasks();
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
      subtitle="Start a dedicated agent with a backlog task or focused prompt"
      className=${className}
    >
      <div class="dispatch-section">
        <div class="meta-text mb-sm">
          ${freeSlots > 0
            ? `${freeSlots} slot${freeSlots > 1 ? "s" : ""} currently free`
            : "All slots are active — dispatch still creates a dedicated agent"}
        </div>
        <div class="input-row">
          <select
            class="input"
            aria-label="Task"
            value=${taskId}
            ref=${inputRef}
            onChange=${(e) => { setTaskId(e.target.value); if (e.target.value) setPrompt(""); }}
          >
            <option value="">
              ${tasksLoading ? "Loading tasks…" : "Select backlog or draft task"}
            </option>
            ${taskChoices.map((task) => html`
              <option key=${task.id} value=${task.id}>
                ${formatTaskOptionLabel(task)}
              </option>
            `)}
          </select>
        </div>
        <div class="divider-label">or</div>
        <textarea
          class="input"
          placeholder="Freeform prompt…"
          rows="2"
          value=${prompt}
          onInput=${(e) => { setPrompt(e.target.value); if (e.target.value) setTaskId(""); }}
        />
        <button
          class="btn btn-primary"
          disabled=${!canDispatch || dispatching}
          onClick=${handleDispatch}
        >
          ${dispatching ? "Dispatching…" : iconText("🚀 Dispatch")}
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
  const maxParallel = execData?.maxParallel || (slots.length || 0);
  const derivedActiveSlots = slots.filter((slot) => {
    const status = String(slot?.status || "").toLowerCase();
    return status === "running" || status === "busy";
  }).length;
  const activeSlots = slots.length ? derivedActiveSlots : (execData?.activeSlots || 0);

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
    let active = true;
    const refreshTaskSessions = () => {
      if (!active) return;
      loadSessions({ type: "task" });
    };
    refreshTaskSessions();
    const interval = setInterval(refreshTaskSessions, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

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
    <div class="fleet-layout">
      <div class="fleet-span">
        <${Card}
          title="Fleet Overview"
          subtitle="Capacity, health, and quick actions"
          className="fleet-overview-card"
        >
          <div class="fleet-hero">
            <div class="fleet-health">
              <div class="fleet-label">Health</div>
              <div class="fleet-health-value">
                <span
                  class="fleet-health-dot"
                  style=${`background:${healthColor}`}
                ></span>
                <span>${healthLabel}</span>
              </div>
              <div class="fleet-subtext">${healthSubtext}</div>
              ${lastErrorSlot && statusCounts.error > 0 &&
              html`<div class="fleet-alert">
                Last error: ${truncate(lastErrorSlot.lastError || "Unknown error", 90)}
              </div>`}
            </div>

            <div class="fleet-capacity">
              <div class="fleet-label">Capacity</div>
              <div class="fleet-capacity-value">
                ${activeSlots}
                <span class="fleet-capacity-divider">/</span>
                ${maxParallel}
              </div>
              <div class="fleet-subtext">
                ${capacityPct}% used · ${freeSlots} free
              </div>
              <div class="fleet-capacity-bar">
                <${ProgressBar} percent=${capacityPct} />
              </div>
            </div>
          </div>

          <div class="fleet-metrics">
            ${fleetMetrics.map(
              (metric) => html`
                <div class="fleet-metric" key=${metric.label}>
                  <div class="fleet-metric-label">${metric.label}</div>
                  <div class="fleet-metric-value">${metric.value}</div>
                </div>
              `,
            )}
          </div>

          <div class="fleet-quick-actions">
            <button class="btn btn-primary btn-sm" onClick=${handleFocusDispatch}>
              ${iconText("🚀 Dispatch")}
            </button>
            <button class="btn btn-secondary btn-sm" onClick=${handleFleetRefresh}>
              ↻ Refresh
            </button>
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => navigateTo("logs")}
            >
              ${iconText("📄 Logs")}
            </button>
          </div>
        <//>
      </div>

      <div class="fleet-column">
        <${DispatchSection}
          freeSlots=${freeSlots}
          inputRef=${dispatchInputRef}
          className="fleet-dispatch-card"
        />

        <${Card} className="fleet-slotmap-card">
          <${Collapsible} title="Slot Map" defaultOpen=${!isCompact}>
            <div class="meta-text mb-sm">Tap a slot to open the workspace.</div>
            <div class="slot-grid">
              ${Array.from(
                { length: Math.max(maxParallel, slots.length, activeSlots, 1) },
                (_, i) => {
                  const slot = slots[i];
                  const st = slot ? slot.status || "busy" : "idle";
                  return html`
                    <div
                      key=${i}
                      class="slot-cell slot-${st}"
                      title=${slot
                        ? `${slot.taskTitle || slot.taskId} (${st})`
                        : `Slot ${i + 1} idle`}
                      onClick=${() => slot && openWorkspace(slot, i)}
                    >
                      <${StatusDot} status=${st} />
                      <span class="slot-label">${i + 1}</span>
                    </div>
                  `;
                },
              )}
            </div>
          <//>
        <//>
      </div>

      <div class="fleet-column">
        <${Card} className="fleet-active-card">
          <${Collapsible}
            title=${activeSlots > 0
              ? `Active Slots · ${activeSlots} active`
              : "Active Slots"}
            defaultOpen=${!isCompact}
          >
            <div class="meta-text mb-sm">
              ${activeSlots > 0
                ? `${activeSlots} active · ${freeSlots} free`
                : "No active slots"}
            </div>
            ${slots.length
              ? slots.map(
                  (slot, i) => html`
                    <div
                      key=${slot?.taskId || slot?.sessionId || `slot-${i}`}
                      class="task-card fleet-agent-card ${expandedSlot === i
                        ? "task-card-expanded"
                        : ""}"
                    >
                      <div
                        class="task-card-header"
                        onClick=${() => toggleExpand(i)}
                        style="cursor:pointer"
                      >
                        <div>
                          <div class="task-card-title">
                            <${StatusDot} status=${slot.status || "busy"} />
                            ${slot.taskTitle || "(no title)"}
                          </div>
                          <div class="task-card-meta">
                            ${slot.taskId || "?"} · Agent
                            ${slot.agentInstanceId || "n/a"} · ${slot.sdk || "?"}${slot.model ? ` · ${slot.model}` : ""}
                          </div>
                        </div>
                        <${Badge}
                          status=${slot.status || "busy"}
                          text=${slot.status || "busy"}
                        />
                      </div>
                      <div class="flex-between">
                        <div class="meta-text">Attempt ${slot.attempt || 1}</div>
                        ${slot.startedAt && html`
                          <div class="agent-duration">${formatDuration(slot.startedAt)}</div>
                        `}
                      </div>

                      ${(slot.status === "running" || slot.status === "busy") &&
                    html`
                      <div class="agent-progress-bar mt-sm">
                        <div
                          class="agent-progress-bar-fill agent-progress-pulse"
                        ></div>
                      </div>
                    `}

                    ${expandedSlot === i &&
                    html`
                      <div class="agent-detail mt-sm">
                        ${slot.branch &&
                        html`<div class="meta-text">Branch: ${slot.branch}</div>`}
                        ${slot.startedAt &&
                        html`<div class="meta-text">
                          Started: ${formatRelative(slot.startedAt)}
                        </div>`}
                        ${slot.completedCount != null &&
                        html`<div class="meta-text">
                          Completed: ${slot.completedCount} tasks
                        </div>`}
                        ${slot.avgDurationMs &&
                        html`<div class="meta-text">
                          Avg: ${Math.round(slot.avgDurationMs / 1000)}s
                        </div>`}
                        ${slot.model &&
                        html`<div class="meta-text">Model: ${slot.model}</div>`}
                        ${slot.lastError &&
                        html`<div
                          class="meta-text"
                          style="color:var(--color-error)"
                        >
                          Last error: ${truncate(slot.lastError, 100)}
                        </div>`}
                      </div>
                    `}

                    <div class="btn-row mt-sm">
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick=${() =>
                          viewAgentLogs(
                            (slot.taskId || slot.branch || "").slice(0, 12),
                          )}
                      >
                        ${iconText("📄 Logs")}
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick=${() =>
                          sendCommandToChat(
                            `/steer focus on ${slot.taskTitle || slot.taskId}`,
                          )}
                      >
                        ${iconText("🎯 Steer")}
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick=${() => openWorkspace(slot, i)}
                      >
                        ${iconText("🔍 View")}
                      </button>
                      <button
                        class="btn btn-danger btn-sm"
                        onClick=${() => handleForceStop({ ...slot, index: i })}
                      >
                        ${iconText("⛔ Stop")}
                      </button>
                    </div>
                  </div>
                `,
              )
            : html`<${EmptyState} message=${activeSlots > 0
              ? "Active slots reported, but slot details haven't arrived yet."
              : "No active agents."} />`}
        <//>
      <//>
      </div>

      <div class="fleet-span">
        <${FleetSessionsPanel}
          slots=${slots}
          onOpenWorkspace=${openWorkspace}
          onForceStop=${handleForceStop}
        />
      </div>

      ${agents.length > 0 &&
      html`
        <div class="fleet-span">
          <${Collapsible} title="Agent Threads" defaultOpen=${false}>
            <${Card} className="fleet-threads-card">
              <div class="stats-grid">
                ${agents.map(
                  (t, i) => html`
                    <${StatCard}
                      key=${t.taskKey || t.id || `thread-${i}`}
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
    return html`<div class="chat-view" style="padding:16px;">
      <${SkeletonCard} height="40px" />
      <${SkeletonCard} height="120px" className="mt-sm" />
      <${SkeletonCard} height="80px" className="mt-sm" />
    </div>`;
  }

  if (error) {
    return html`<div class="chat-view chat-empty-state">
      <div class="session-empty-icon" style="color:var(--color-error)">${resolveIcon("⚠️")}</div>
      <div class="session-empty-text">${error}</div>
      <button class="btn btn-primary btn-sm mt-sm" onClick=${() => { setLoading(true); setError(null); fetchContext(); }}>${iconText("🔄 Retry")}</button>
    </div>`;
  }

  if (!ctx?.context) {
    return html`<div class="chat-view chat-empty-state">
      <div class="session-empty-icon">${resolveIcon("📋")}</div>
      <div class="session-empty-text">No context available for this session</div>
    </div>`;
  }

  const c = ctx.context;
  const ab = parseAheadBehind(c.gitAheadBehind);
  const commits = parseCommits(c.gitLogDetailed);
  const files = parseStatus(c.gitStatus);
  const isDirty = files.length > 0;

  return html`
    <div class="chat-view" style="padding:12px; overflow-y:auto;">
      <!-- Toolbar -->
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-bottom:12px;">
        <button class="btn btn-ghost btn-sm" onClick=${() => { setLoading(true); fetchContext(); }}>
          <span class="icon-inline">${ICONS.refresh}</span> Refresh
        </button>
        <button class="btn btn-ghost btn-sm" onClick=${copyContext}>
          <span class="icon-inline">${ICONS.copy}</span> Copy Context
        </button>
      </div>

      <!-- Branch & Status -->
      <div class="card mb-sm">
        <div class="card-title" style="display:flex; align-items:center; gap:8px;">
          <span class="icon-inline">${ICONS.git}</span> Branch & Status
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:8px;">
          <div style="flex:1; min-width:120px;">
            <div class="meta-text">Branch</div>
            <div style="font-weight:600; font-family:monospace; font-size:13px;">${c.gitBranch || "unknown"}</div>
          </div>
          <div>
            <div class="meta-text">Status</div>
            <${Badge}
              status=${isDirty ? "inprogress" : "done"}
              text=${isDirty ? `${files.length} changed` : "Clean"}
            />
          </div>
          ${(ab.ahead > 0 || ab.behind > 0) && html`
            <div>
              <div class="meta-text">Sync</div>
              <div style="font-size:13px;">
                ${ab.ahead > 0 ? html`<span style="color:var(--color-done)">↑${ab.ahead}</span>` : null}
                ${ab.ahead > 0 && ab.behind > 0 ? " " : null}
                ${ab.behind > 0 ? html`<span style="color:var(--color-error)">↓${ab.behind}</span>` : null}
              </div>
            </div>
          `}
        </div>
      </div>

      <!-- Working Directory -->
      <div class="card mb-sm">
        <div class="card-title" style="display:flex; align-items:center; gap:8px;">
          <span class="icon-inline">${ICONS.folder}</span> Working Directory
        </div>
        <div style="font-family:monospace; font-size:12px; color:var(--text-secondary); margin-top:6px; word-break:break-all;">
          ${c.path || "unknown"}
        </div>
      </div>

      <!-- Recent Commits -->
      ${commits.length > 0 && html`
        <div class="card mb-sm">
          <div class="card-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon-inline">${ICONS.clock}</span> Recent Commits
          </div>
          <div style="margin-top:8px;">
            ${commits.map((cm) => html`
              <div key=${cm.hash} style="display:flex; gap:8px; align-items:baseline; padding:4px 0; border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06));">
                <code style="color:var(--color-inprogress); font-size:12px; flex-shrink:0;">${cm.hash}</code>
                <span style="flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${cm.message}</span>
                <span class="meta-text" style="flex-shrink:0; font-size:11px;">${cm.time}</span>
              </div>
            `)}
          </div>
        </div>
      `}

      <!-- Modified Files -->
      ${files.length > 0 && html`
        <div class="card mb-sm">
          <div class="card-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon-inline">${ICONS.edit}</span> Modified Files
            <${Badge} text="${files.length}" className="ml-auto" />
          </div>
          <div style="margin-top:8px;">
            ${files.map((f) => html`
              <div key=${f.file} style="display:flex; gap:8px; align-items:center; padding:4px 0; border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06));">
                <code style="color:${statusColor(f.code)}; font-size:11px; font-weight:700; min-width:20px; text-align:center;" title=${statusLabel(f.code)}>${f.code}</code>
                <span style="font-family:monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${f.file}</span>
              </div>
            `)}
          </div>
        </div>
      `}

      <!-- Diff Stats -->
      ${c.gitDiffStat && html`
        <div class="card mb-sm">
          <div class="card-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon-inline">${ICONS.terminal}</span> Diff Summary
          </div>
          <pre style="font-size:11px; margin:8px 0 0; white-space:pre-wrap; color:var(--text-secondary); overflow-x:auto;">${c.gitDiffStat}</pre>
        </div>
      `}
    </div>
  `;
}

/* ─── Fleet Full Session View ─── */
function FleetSessionsPanel({ slots, onOpenWorkspace, onForceStop }) {
  const [detailTab, setDetailTab] = useState("stream");
  const [selectedSlotKey, setSelectedSlotKey] = useState(null);
  const [logText, setLogText] = useState("(no logs yet)");
  const logRef = useRef(null);
  const allSessions = sessionsData.value || [];

  /* Stabilise entries with useMemo so the reference only changes when the
     underlying data actually changes – prevents infinite render loops that
     previously caused "insertBefore" DOM errors. */
  const entries = useMemo(() => {
    return (slots || [])
      .map((slot, index) => {
        const session =
          allSessions.find((s) => s?.id && slot?.sessionId && s.id === slot.sessionId) ||
          allSessions.find((s) => {
            if (!slot?.taskId) return false;
            return s?.taskId === slot.taskId || s?.id === slot.taskId;
          }) ||
          null;
        const key = String(slot?.taskId || slot?.sessionId || `slot-${index}`);
        return { key, slot, index, session };
      })
      .sort((a, b) => {
        const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
        const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
        return bScore - aScore;
      });
  }, [slots, allSessions]);

  /* Build a stable fingerprint so the effect only fires when entries actually
     change rather than on every render (entries is now memoised but we still
     guard with a primitive dep). */
  const entriesFingerprint = entries.map((e) => e.key).join(",");

  useEffect(() => {
    if (!entries.length) {
      setSelectedSlotKey(null);
      return;
    }
    const existing = entries.some((entry) => entry.key === selectedSlotKey);
    if (!existing) setSelectedSlotKey(entries[0].key);
  }, [entriesFingerprint]);

  const selectedEntry =
    entries.find((entry) => entry.key === selectedSlotKey) || entries[0] || null;
  const sessionId = selectedEntry?.session?.id || null;
  const contextId = sessionId || selectedEntry?.slot?.taskId || null;

  useEffect(() => {
    if (sessionId) selectedSessionId.value = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const query =
      selectedEntry?.slot?.branch ||
      selectedEntry?.slot?.taskId ||
      selectedEntry?.session?.id ||
      "";
    if (!query) {
      setLogText("(no logs yet)");
      return undefined;
    }
    let active = true;
    const fetchLogs = () => {
      apiFetch(`/api/agent-logs/tail?query=${encodeURIComponent(query)}&lines=220`, { _silent: true })
        .then((res) => {
          if (!active) return;
          const data = res.data ?? res ?? "";
          const content =
            typeof data === "string"
              ? data
              : data?.content || data?.lines || data?.data || "";
          const text = Array.isArray(content) ? content.join("\n") : content || "";
          setLogText(text || "(no logs yet)");
          if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        })
        .catch(() => {
          if (active) setLogText("(failed to load logs)");
        });
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedEntry?.key]);

  return html`
    <${Card}
      title="Fleet Session View"
      subtitle="Slots and agent sessions with full execution detail"
      className="fleet-fullview-card"
    >
      <div class="fleet-fullview">
        <div class="fleet-slot-rail">
          ${entries.length === 0
            ? html`<div class="meta-text">No active slots</div>`
            : html`${entries.map((entry) => html`
                <button
                  key=${entry.key}
                  class="fleet-slot-item ${selectedEntry?.key === entry.key ? "active" : ""}"
                  onClick=${() => {
                    haptic();
                    setSelectedSlotKey(entry.key);
                    setDetailTab("stream");
                  }}
                >
                  <div class="fleet-slot-item-title">
                    <${StatusDot} status=${entry.slot?.status || "busy"} />
                    ${truncate(entry.slot?.taskTitle || "(untitled)", 50)}
                  </div>
                  <div class="fleet-slot-item-meta">
                    Slot ${(entry.index ?? 0) + 1} · ${entry.slot?.taskId || "no-task-id"}
                  </div>
                </button>
              `)}`}
        </div>
        <div class="session-detail fleet-session-detail">
          ${selectedEntry
            ? html`
                <div class="fleet-session-header">
                  <div>
                    <div class="task-card-title">
                      <${StatusDot} status=${selectedEntry.slot?.status || "busy"} />
                      ${selectedEntry.slot?.taskTitle || "(untitled)"}
                    </div>
                    <div class="task-card-meta">
                      ${selectedEntry.slot?.taskId || "?"} · Slot ${(selectedEntry.index ?? 0) + 1}
                      ${selectedEntry.slot?.branch ? ` · ${selectedEntry.slot.branch}` : ""}
                    </div>
                  </div>
                  <div class="btn-row">
                    <button class="btn btn-ghost btn-sm" onClick=${() => onOpenWorkspace(selectedEntry.slot, selectedEntry.index)}>
                      ${iconText("🔍 Workspace")}
                    </button>
                    <button class="btn btn-danger btn-sm" onClick=${() => onForceStop({ ...selectedEntry.slot, index: selectedEntry.index })}>
                      ${iconText("⛔ Stop")}
                    </button>
                  </div>
                </div>
                <div class="session-detail-tabs">
                  <button
                    class="session-detail-tab ${detailTab === "stream" ? "active" : ""}"
                    onClick=${() => setDetailTab("stream")}
                  >${iconText("💬 Stream")}</button>
                  <button
                    class="session-detail-tab ${detailTab === "context" ? "active" : ""}"
                    onClick=${() => setDetailTab("context")}
                  >${iconText("📋 Context")}</button>
                  <button
                    class="session-detail-tab ${detailTab === "diff" ? "active" : ""}"
                    onClick=${() => setDetailTab("diff")}
                  >${iconText("📝 Diff")}</button>
                  <button
                    class="session-detail-tab ${detailTab === "logs" ? "active" : ""}"
                    onClick=${() => setDetailTab("logs")}
                  >${iconText("📄 Logs")}</button>
                </div>
                <div class="fleet-session-body">
                  ${detailTab === "stream"
                    ? sessionId
                      ? html`<${ChatView} sessionId=${sessionId} readOnly=${true} />`
                      : html`
                          <div class="chat-view chat-empty-state">
                            <div class="session-empty-icon">${resolveIcon("💬")}</div>
                            <div class="session-empty-text">No linked chat session found for this slot</div>
                          </div>
                        `
                    : detailTab === "context"
                      ? contextId
                        ? html`<${ContextViewer} sessionId=${contextId} />`
                        : html`
                            <div class="chat-view chat-empty-state">
                              <div class="session-empty-icon">${resolveIcon("📋")}</div>
                              <div class="session-empty-text">No context source available</div>
                            </div>
                          `
                      : detailTab === "diff"
                        ? sessionId
                          ? html`<${DiffViewer} sessionId=${sessionId} />`
                          : html`
                              <div class="chat-view chat-empty-state">
                                <div class="session-empty-icon">${resolveIcon("📝")}</div>
                                <div class="session-empty-text">Diff requires a linked session</div>
                              </div>
                            `
                        : detailTab === "logs"
                          ? html`<div class="workspace-log fleet-session-log" ref=${logRef}>${logText}</div>`
                          : null}
                </div>
              `
            : html`
                <div class="chat-view chat-empty-state">
                  <div class="session-empty-icon">${resolveIcon("💬")}</div>
                  <div class="session-empty-text">Select a slot to open full session view</div>
                </div>
              `}
        </div>
      </div>
    <//>
  `;
}
