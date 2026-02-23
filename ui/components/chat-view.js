/* ─────────────────────────────────────────────────────────────
 *  Component: Chat View — ChatGPT-style message interface
 *  with real-time WS push, optimistic rendering, agent status
 *  tracking, and pending/retry message support.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { memo } from "preact/compat";
import { useState, useEffect, useRef, useCallback, useMemo } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";
import { formatRelative, truncate } from "../modules/utils.js";
import {
  sessionMessages,
  loadSessionMessages,
  loadSessions,
  selectedSessionId,
  sessionsData,
} from "./session-list.js";
import {
  pendingMessages,
  typingIndicator,
  agentStatus,
  agentStatusText,
  startAgentStatusTracking,
  retryPendingMessage,
  clearPendingMessages,
} from "../modules/streaming.js";
import {
  startAgentEventTracking,
  agentAutoActions,
  totalErrorCount,
} from "../modules/agent-events.js";

const html = htm.bind(h);

const AUTO_ACTION_LABELS = {
  "agent:auto-retry": "Auto Retry",
  "agent:auto-review": "Auto Review",
  "agent:auto-cooldown": "Cooldown",
  "agent:auto-block": "Auto Block",
  "agent:auto-new-session": "New Session",
  "agent:executor-paused": "Executor Paused",
  "agent:executor-resumed": "Executor Resumed",
};

const SCROLL_BOTTOM_TOLERANCE_PX = 6;
const SCROLL_BOTTOM_RATIO = 0.995;

function formatAutoAction(event) {
  if (!event) return null;
  const label =
    AUTO_ACTION_LABELS[event.type] ||
    event.type.replace(/^agent:/, "").replace(/-/g, " ");
  const task =
    event.payload?.title ||
    event.payload?.branch ||
    event.payload?.taskId ||
    event.taskId ||
    "";
  return {
    label,
    task: truncate(task, 28),
    ts: event.ts || Date.now(),
  };
}

/* ─── Inline markdown formatting ─── */
function applyInline(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (/^(https?:|mailto:|\/|#)/.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener" class="md-link">${label}</a>`;
    }
    return `${label} (${url})`;
  });
  return text;
}

/* ─── Convert markdown text to HTML ─── */
function renderMarkdown(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `%%ICODE${codes.length - 1}%%`;
  });

  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = s.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if ((m = line.match(/^(#{1,3}) (.+)$/))) {
      const lvl = m[1].length;
      out.push(`<div class="md-heading md-h${lvl}">${applyInline(m[2])}</div>`);
      i++; continue;
    }

    if (/^-{3,}\s*$/.test(line.trim())) {
      out.push('<hr class="md-hr"/>');
      i++; continue;
    }

    if (/^&gt;\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        q.push(applyInline(lines[i].replace(/^&gt;\s?/, '')));
        i++;
      }
      out.push(`<div class="md-blockquote">${q.join('<br/>')}</div>`);
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${applyInline(lines[i].replace(/^[-*] /, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(`<li>${applyInline(lines[i].replace(/^\d+\.\s/, ''))}</li>`);
        i++;
      }
      out.push(`<ol class="md-list md-ol">${items.join('')}</ol>`);
      continue;
    }

    out.push(applyInline(line));
    i++;
  }

  let result = out.join('\n').replace(/\n/g, '<br/>');

  result = result.replace(/%%ICODE(\d+)%%/g, (_, idx) => {
    const c = codes[parseInt(idx)]
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="md-inline-code">${c}</span>`;
  });

  return result;
}

/* ─── Markdown render cache — avoids re-parsing identical content ─── */
const _mdCache = new Map();
const MD_CACHE_MAX = 500;
function cachedRenderMarkdown(text) {
  if (_mdCache.has(text)) return _mdCache.get(text);
  const html = renderMarkdown(text);
  if (_mdCache.size >= MD_CACHE_MAX) {
    // Evict oldest quarter when full
    const keys = Array.from(_mdCache.keys()).slice(0, MD_CACHE_MAX >> 2);
    for (const k of keys) _mdCache.delete(k);
  }
  _mdCache.set(text, html);
  return html;
}

/* ─── Code block copy button ─── */
const CodeBlock = memo(function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    try {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  }, [code]);

  return html`
    <div class="chat-code-block">
      <button class="chat-code-copy" onClick=${handleCopy}>
        ${copied ? "✓" : "📋"}
      </button>
      <pre><code>${code}</code></pre>
    </div>
  `;
});

/* ─── Render message content with code block + markdown support ─── */
const MessageContent = memo(function MessageContent({ text }) {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return html`${parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3).replace(/^\w+\n/, "");
      return html`<${CodeBlock} key=${i} code=${code} />`;
    }
    return html`<div key=${i} class="md-rendered" dangerouslySetInnerHTML=${{ __html: cachedRenderMarkdown(part) }} />`;
  })}`;
});

/* ─── Stream helpers ─── */
function categorizeMessage(msg) {
  const type = (msg?.type || "").toLowerCase();
  if (type === "tool_call") return "tool";
  if (type === "tool_result" || type === "tool_output") return "result";
  if (type === "error" || type === "stream_error") return "error";
  return "message";
}

function isThinkingTraceMessage(msg) {
  if (!msg) return false;
  const category = categorizeMessage(msg);
  if (category === "tool" || category === "result" || category === "error") {
    return true;
  }
  return (msg.type || "").toLowerCase() === "system";
}

function formatMessageLine(msg) {
  const timestamp = msg?.timestamp || "";
  const kind = msg?.role || msg?.type || "message";
  const content =
    typeof msg?.content === "string"
      ? msg.content
      : msg?.content
        ? JSON.stringify(msg.content)
        : "";
  return `[${timestamp}] ${String(kind).toUpperCase()}: ${content}`;
}

/* ─── Memoized ChatBubble — only re-renders if msg identity changes ─── */
const ChatBubble = memo(function ChatBubble({ msg }) {
  const isTool = msg.type === "tool_call" || msg.type === "tool_result";
  const isError = msg.type === "error" || msg.type === "stream_error";
  const role = msg.role ||
    (isTool || isError ? "system" : msg.type === "system" ? "system" : "assistant");
  const bubbleClass = isError
    ? "error"
    : isTool
      ? "tool"
      : role === "user"
        ? "user"
        : role === "system"
          ? "system"
          : "assistant";
  const label =
    isTool
      ? msg.type === "tool_call" ? "TOOL CALL" : "TOOL RESULT"
      : isError ? "ERROR" : null;
  return html`
    <div class="chat-bubble ${bubbleClass}">
      ${role === "system" && !isTool
        ? html`<div class="chat-system-text">${msg.content}</div>`
        : html`
            ${label ? html`<div class="chat-bubble-label">${label}</div>` : null}
            <div class="chat-bubble-content">
              <${MessageContent} text=${msg.content} />
            </div>
            <div class="chat-bubble-time">
              ${msg.timestamp ? formatRelative(msg.timestamp) : ""}
            </div>
          `}
    </div>
  `;
}, (prev, next) => prev.msg === next.msg);

const ThinkingPanel = memo(function ThinkingPanel({ entries }) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return html`
    <details class="chat-thinking-panel">
      <summary class="chat-thinking-summary">
        🧠 Thinking · ${entries.length} ${entries.length === 1 ? "step" : "steps"}
      </summary>
      <div class="chat-thinking-body">
        ${entries.map((entry, index) => {
          const category = categorizeMessage(entry);
          const label =
            category === "tool"
              ? "Tool"
              : category === "result"
                ? "Result"
                : category === "error"
                  ? "Error"
                  : "System";
          return html`
            <div class="chat-thinking-item" key=${entry.id || entry.timestamp || `thinking-${index}`}>
              <div class="chat-thinking-item-label">${label}</div>
              <div class="chat-thinking-item-content">
                <${MessageContent} text=${entry.content || ""} />
              </div>
            </div>
          `;
        })}
      </div>
    </details>
  `;
});

/* ─── Chat View component ─── */
export function ChatView({ sessionId, readOnly = false, embedded = false }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(200);
  const [showStreamMeta, setShowStreamMeta] = useState(false);
  const [filters, setFilters] = useState({
    tool: false,
    result: false,
    error: false,
  });
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const lastMessageCount = useRef(0);
  const filterKey = `${filters.tool}-${filters.result}-${filters.error}`;

  const isScrollPinnedToBottom = useCallback((el) => {
    if (!el) return true;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScrollTop <= SCROLL_BOTTOM_TOLERANCE_PX) return true;
    const distanceFromBottom = maxScrollTop - el.scrollTop;
    const scrollRatio = maxScrollTop > 0 ? el.scrollTop / maxScrollTop : 1;
    return (
      distanceFromBottom <= SCROLL_BOTTOM_TOLERANCE_PX ||
      scrollRatio >= SCROLL_BOTTOM_RATIO
    );
  }, []);

  let messages = [];
  try {
    messages = sessionMessages.value || [];
  } catch (err) {
    console.warn("[ChatView] Failed to read sessionMessages:", err);
  }

  /* Safely read signal values — if any signal is in a broken state (e.g. from a
     module load race or a WebSocket push that corrupted state), we default to
     safe empty values so the component renders instead of crashing.
     
     Use .peek() for signals whose changes should NOT trigger a re-render of
     this component. sessionsData changes frequently (sidebar metadata), but
     we only need the session status for the header — not worth re-rendering
     the entire message list. */
  let session = null;
  try {
    session = (sessionsData.peek() || []).find((s) => s.id === sessionId) || null;
  } catch (err) {
    console.warn("[ChatView] Failed to read sessionsData:", err);
  }
  const isActive =
    session?.status === "active" || session?.status === "running";
  const resumeLabel =
    session?.status === "archived" ? "Unarchive" : "Resume Session";

  /* Memoize the filter key list so filteredMessages memoization works properly.
     Previously a new array was created every render, breaking useMemo deps. */
  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, v]) => v).map(([k]) => k),
    [filterKey],
  );

  const counts = useMemo(() => {
    return messages.reduce(
      (acc, msg) => {
        const category = categorizeMessage(msg);
        acc.total += 1;
        if (category === "tool") acc.tool += 1;
        else if (category === "result") acc.result += 1;
        else if (category === "error") acc.error += 1;
        else acc.message += 1;
        return acc;
      },
      { total: 0, tool: 0, result: 0, error: 0, message: 0 },
    );
  }, [messages]);

  const filteredMessages = useMemo(() => {
    if (activeFilters.length === 0) return messages;
    return messages.filter((msg) => activeFilters.includes(categorizeMessage(msg)));
  }, [messages, activeFilters]);

  const visibleMessages = useMemo(() => {
    if (filteredMessages.length <= visibleCount) return filteredMessages;
    return filteredMessages.slice(-visibleCount);
  }, [filteredMessages, visibleCount]);

  const hasMoreMessages = filteredMessages.length > visibleCount;

  const streamActivityKey = useMemo(() => {
    if (filteredMessages.length === 0) return "empty";
    const last = filteredMessages[filteredMessages.length - 1] || {};
    const id = last.id || last.timestamp || filteredMessages.length;
    const role = last.role || last.type || "message";
    const contentLen =
      typeof last.content === "string"
        ? last.content.length
        : last.content
          ? JSON.stringify(last.content).length
          : 0;
    return `${filteredMessages.length}:${id}:${role}:${contentLen}`;
  }, [filteredMessages]);

  /* Use .peek() for auto-actions — these are low-priority decorations, not
     worth triggering a full ChatView re-render for. The component will pick
     them up on the next render triggered by messages or other signals. */
  const recentAutoActions = useMemo(() => {
    try {
      const items = (agentAutoActions.peek() || []).slice(0, 3);
      return items.map(formatAutoAction).filter(Boolean);
    } catch {
      return [];
    }
  }, [messages.length]);

  /* Keep status indicators fully live while an agent is active. */
  let errorCount = 0;
  let statusState = "idle";
  let statusText = "";
  try {
    errorCount = totalErrorCount.value || 0;
    statusState = paused ? "paused" : (agentStatus.value?.state || "idle");
    statusText = paused ? "Stream paused" : (agentStatusText.value || "Ready");
  } catch (err) {
    console.warn("[ChatView] Failed to read status signals:", err);
    statusState = paused ? "paused" : "idle";
    statusText = paused ? "Stream paused" : "Ready";
  }

  const renderItems = useMemo(() => {
    const items = [];
    let pendingThinking = [];
    let panelIndex = 0;

    const flushThinking = (anchor = "") => {
      if (pendingThinking.length === 0) return;
      const seed = pendingThinking[0]?.id || pendingThinking[0]?.timestamp || panelIndex;
      items.push({
        kind: "thinking",
        key: `thinking-${sessionId || "session"}-${seed}-${anchor}-${panelIndex}`,
        entries: pendingThinking,
      });
      pendingThinking = [];
      panelIndex += 1;
    };

    for (const msg of visibleMessages) {
      if (isThinkingTraceMessage(msg)) {
        pendingThinking.push(msg);
        continue;
      }

      const isAssistantMessage =
        (msg.role || "") === "assistant" || (msg.type || "") === "agent_message";
      if (isAssistantMessage) {
        flushThinking(msg.id || msg.timestamp || "assistant");
      }

      const baseKey = msg.id || msg.timestamp || "msg";
      items.push({
        kind: "message",
        key: `message-${baseKey}-${items.length}`,
        msg,
      });
    }

    flushThinking("tail");
    return items;
  }, [visibleMessages, sessionId]);

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    const res = await loadSessionMessages(sessionId).finally(() => setLoading(false));
    setLoadError(res?.ok ? null : res?.error || "unavailable");
  }, [sessionId]);

  /* Load messages on mount; WS push via initSessionWsListener handles real-time */
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    // Use a small delay to let the Chat tab's session list settle first
    const timer = setTimeout(() => {
      if (!active) return;
      if (!paused) {
        setLoading(true);
        loadSessionMessages(sessionId).then((res) => {
          if (active) setLoadError(res?.ok ? null : res?.error || "unavailable");
        }).finally(() => {
          if (active) setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }, 100);

    // Fallback: poll slowly as safety net (30s) - WS does the heavy lifting
    const interval = setInterval(() => {
      if (active && !paused) {
        loadSessionMessages(sessionId).then((res) => {
          if (active && res?.ok === false) setLoadError(res?.error || "unavailable");
        });
      }
    }, 30000);

    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [sessionId, paused]);

  /* Start agent status tracking from WS events — deferred to avoid
     signal cascade during initial mount */
  useEffect(() => {
    let cleanup1 = null;
    let cleanup2 = null;
    const timer = setTimeout(() => {
      cleanup1 = startAgentStatusTracking();
      cleanup2 = startAgentEventTracking();
    }, 200);
    return () => {
      clearTimeout(timer);
      if (cleanup1) cleanup1();
      if (cleanup2) cleanup2();
    };
  }, []);

  /* Clear pending messages when switching sessions */
  useEffect(() => {
    if (sessionId) clearPendingMessages(sessionId);
  }, [sessionId]);

  /* Reset visible window when session or filters change */
  useEffect(() => {
    setVisibleCount(200);
    setUnreadCount(0);
    setAutoScroll(true);
  }, [sessionId, filterKey]);

  /* Track scroll position to decide auto-scroll + unread */
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      const pinnedToBottom = isScrollPinnedToBottom(el);
      setAutoScroll(pinnedToBottom);
      if (pinnedToBottom) setUnreadCount(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId, isScrollPinnedToBottom]);

  /* Auto-scroll to bottom when new messages arrive */
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const prevCount = lastMessageCount.current;
    const nextCount = messages.length;
    const newMessages = nextCount > prevCount;
    lastMessageCount.current = nextCount;
    if (!paused && autoScroll) {
      // Use smooth scroll for small increments, instant for large jumps
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      el.scrollTo({ top: el.scrollHeight, behavior: gap < 800 ? "smooth" : "auto" });
      return;
    }
    if (newMessages && !autoScroll) {
      setUnreadCount((prev) => prev + (nextCount - prevCount));
    }
  }, [messages.length, streamActivityKey, paused, autoScroll]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || readOnly) return;

    /* Optimistically add user message */
    const optimistic = {
      id: `opt-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    sessionMessages.value = [...(sessionMessages.value || []), optimistic];
    setInput("");
    setSending(true);

    try {
      await apiFetch(`/api/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
      const res = await loadSessionMessages(sessionId);
      setLoadError(res?.ok ? null : res?.error || "unavailable");
    } catch {
      showToast("Failed to send message", "error");
    } finally {
      setSending(false);
    }
  }, [input, sending, sessionId]);

  const handleResume = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}/resume`, { method: "POST" });
      showToast(
        session?.status === "archived" ? "Session unarchived" : "Session resumed",
        "success",
      );
      await loadSessions();
      const res = await loadSessionMessages(sessionId);
      setLoadError(res?.ok ? null : res?.error || "unavailable");
    } catch {
      showToast("Failed to resume session", "error");
    }
  }, [sessionId]);

  const handleArchive = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}/archive`, { method: "POST" });
      showToast("Session archived", "success");
      await loadSessions();
      const res = await loadSessionMessages(sessionId);
      setLoadError(res?.ok ? null : res?.error || "unavailable");
    } catch {
      showToast("Failed to archive session", "error");
    }
  }, [sessionId]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback((e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const toggleFilter = useCallback((key) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ tool: false, result: false, error: false });
  }, []);

  const handleCopyStream = useCallback(() => {
    if (!sessionId) return;
    const title = session?.title || session?.taskId || sessionId;
    const filterLabel =
      activeFilters.length > 0 ? activeFilters.join(", ") : "all";
    const header = `Session: ${title}\nStatus: ${session?.status || "unknown"}\nFilters: ${filterLabel}\nExported: ${new Date().toISOString()}\n\n`;
    const lines = filteredMessages.map(formatMessageLine).join("\n");
    const payload = `${header}${lines}`.trim();
    navigator.clipboard
      .writeText(payload)
      .then(() => showToast("Stream copied", "success"))
      .catch(() => showToast("Copy failed", "error"));
  }, [activeFilters, filteredMessages, session, sessionId]);

  const handleExportStream = useCallback(() => {
    if (!sessionId) return;
    const payload = {
      sessionId,
      title: session?.title || session?.taskId || null,
      status: session?.status || null,
      exportedAt: new Date().toISOString(),
      filters: activeFilters,
      messages: filteredMessages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-${sessionId}-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Stream exported", "success");
  }, [activeFilters, filteredMessages, session, sessionId]);

  if (!sessionId) {
    return html`
      <div class="chat-view chat-empty-state">
        <div class="session-empty-icon">💬</div>
        <div class="session-empty-text">
          Select a session to view the live stream.
          <div class="session-empty-subtext">Create a new session or pick one on the left.</div>
        </div>
      </div>
    `;
  }

  return html`
    <div class="chat-view ${embedded ? 'chat-view-embedded' : ''}">
      ${!embedded && html`
      <div class="chat-header">
        <div class="chat-header-info">
          <div class="chat-header-title">
            ${session?.title || session?.taskId || "Session"}
          </div>
          <div class="chat-header-meta">
            ${session?.type || "manual"} · ${session?.status || "unknown"}
          </div>
        </div>
        <div class="chat-header-actions">
          ${session?.status === "archived" &&
          html`
            <button class="btn btn-primary btn-sm" onClick=${handleResume}>
              Unarchive
            </button>
          `}
          ${session?.status !== "archived" &&
          html`
            <button class="btn btn-ghost btn-sm" onClick=${handleArchive}>
              Archive
            </button>
          `}
        </div>
      </div>
      `}

      ${!embedded && html`
      <div class="chat-toolbar">
        <div class="chat-toolbar-left">
          <div class="chat-filter-group">
            <button
              class="chat-filter-chip ${activeFilters.length === 0 ? "active" : ""}"
              onClick=${clearFilters}
            >
              All
              <span class="chat-filter-count">${counts.total}</span>
            </button>
            <button
              class="chat-filter-chip ${filters.tool ? "active" : ""}"
              onClick=${() => toggleFilter("tool")}
            >
              Tool
              <span class="chat-filter-count">${counts.tool}</span>
            </button>
            <button
              class="chat-filter-chip ${filters.result ? "active" : ""}"
              onClick=${() => toggleFilter("result")}
            >
              Result
              <span class="chat-filter-count">${counts.result}</span>
            </button>
            <button
              class="chat-filter-chip ${filters.error ? "active" : ""}"
              onClick=${() => toggleFilter("error")}
            >
              Error
              <span class="chat-filter-count">${counts.error}</span>
            </button>
          </div>
          ${paused &&
          html`<span class="chat-paused-pill">Paused</span>`}
        </div>
        <div class="chat-toolbar-actions">
          <button class="btn btn-ghost btn-sm" onClick=${refreshMessages}>
            🔄 Refresh
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => setPaused((prev) => !prev)}
          >
            ${paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button class="btn btn-ghost btn-sm" onClick=${handleCopyStream}>
            📋 Copy
          </button>
          <button class="btn btn-ghost btn-sm" onClick=${handleExportStream}>
            ⬇️ Export
          </button>
        </div>
      </div>
      `}

      ${embedded && html`
        <div class="chat-stream-bar">
          <div class="chat-stream-status">
            <span class="chat-stream-dot ${statusState}"></span>
            <div class="chat-stream-text">
              <div class="chat-stream-label">Live Activity</div>
              <div class="chat-stream-value">${statusText}</div>
            </div>
          </div>
          <div class="chat-stream-actions">
            <button class="btn btn-ghost btn-xs" onClick=${refreshMessages} title="Refresh">
              Refresh
            </button>
            <button
              class="btn btn-ghost btn-xs"
              onClick=${() => setPaused((prev) => !prev)}
              title=${paused ? "Resume stream" : "Pause stream"}
            >
              ${paused ? "Resume" : "Pause"}
            </button>
            <button class="btn btn-ghost btn-xs" onClick=${() => setShowStreamMeta((prev) => !prev)} title="Toggle filters">
              ${showStreamMeta ? "Hide filters" : "Filters"}
            </button>
          </div>
        </div>
        <div class="chat-stream-meta ${showStreamMeta ? 'expanded' : ''}">
          <div class="chat-stream-filters">
            <button
              class="chat-filter-chip ${activeFilters.length === 0 ? "active" : ""}"
              onClick=${clearFilters}
            >
              All
              <span class="chat-filter-count">${counts.total}</span>
            </button>
            <button
              class="chat-filter-chip ${filters.tool ? "active" : ""}"
              onClick=${() => toggleFilter("tool")}
            >
              Tool
              <span class="chat-filter-count">${counts.tool}</span>
            </button>
            <button
              class="chat-filter-chip ${filters.result ? "active" : ""}"
              onClick=${() => toggleFilter("result")}
            >
              Result
              <span class="chat-filter-count">${counts.result}</span>
            </button>
            <button
              class="chat-filter-chip ${filters.error ? "active" : ""}"
              onClick=${() => toggleFilter("error")}
            >
              Error
              <span class="chat-filter-count">${counts.error}</span>
            </button>
          </div>
          ${(errorCount > 0 || recentAutoActions.length > 0) && html`
            <div class="chat-stream-events">
              ${errorCount > 0 && html`
                <span class="chat-stream-chip error">Errors · ${errorCount}</span>
              `}
              ${recentAutoActions.map((action) => html`
                <span class="chat-stream-chip">
                  ${action.label}
                  ${action.task ? html`<span class="chat-stream-chip-sub">· ${action.task}</span>` : ""}
                  <span class="chat-stream-chip-time">${formatRelative(action.ts)}</span>
                </span>
              `)}
            </div>
          `}
        </div>
      `}

      <div class="chat-messages" ref=${messagesRef}>
        ${hasMoreMessages && html`
          <div class="chat-load-earlier">
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => setVisibleCount((prev) => prev + 200)}
            >
              Load earlier messages
            </button>
            <span class="chat-load-count">
              Showing ${visibleMessages.length} of ${filteredMessages.length}
            </span>
          </div>
        `}
        ${loadError && !loading && html`
          <div class="chat-error-banner">
            <span>Stream unavailable (${loadError}).</span>
            <button class="btn btn-ghost btn-xs" onClick=${refreshMessages}>
              Retry
            </button>
          </div>
        `}
        ${loading && messages.length === 0 && html`
          <div class="chat-loading">Loading messages…</div>
        `}
        ${!loading && messages.length === 0 && html`
          <div class="chat-empty-state-inline">
            <div class="session-empty-icon">🛰️</div>
            <div class="session-empty-text">
              No messages yet.
              <div class="session-empty-subtext">
                ${readOnly ? "Stream will appear once the agent starts." : "Send a message to kick things off."}
              </div>
            </div>
          </div>
        `}
        ${messages.length > 0 && filteredMessages.length === 0 && html`
          <div class="chat-empty-state-inline">
            <div class="session-empty-icon">🧰</div>
            <div class="session-empty-text">
              No messages match these filters.
              <div class="session-empty-subtext">Try clearing filters or wait for new tool events.</div>
            </div>
            <button class="btn btn-primary btn-sm mt-sm" onClick=${clearFilters}>
              Clear Filters
            </button>
          </div>
        `}
        ${renderItems.map((item) => item.kind === "thinking"
          ? html`<${ThinkingPanel} key=${item.key} entries=${item.entries} />`
          : html`<${ChatBubble} key=${item.key} msg=${item.msg} />`
        )}

        ${/* Pending messages (optimistic rendering) — use .peek() to avoid
              subscribing ChatView to pendingMessages signal. Pending messages
              are updated via handleSend which already triggers a re-render
              through sessionMessages. */
          (pendingMessages.peek() || [])
            .filter((pm) => pm.sessionId === sessionId)
            .map((pm) => html`
              <div key=${pm.tempId} class="chat-bubble user chat-pending-msg ${pm.status}">
                <div class="chat-bubble-content">
                  <${MessageContent} text=${pm.content} />
                </div>
                <div class="chat-bubble-time chat-pending-status">
                  ${pm.status === "sending"
                    ? "Sending…"
                    : pm.status === "uncertain"
                      ? html`<span class="chat-pending-warn">⚠ Uncertain</span>
                              <button class="btn btn-ghost btn-xs chat-retry-btn"
                                onClick=${() => retryPendingMessage(pm.tempId)}>↻ Retry</button>`
                      : pm.status === "failed"
                        ? html`<span class="chat-pending-err">✘ Failed${pm.error ? `: ${pm.error}` : ""}</span>
                                <button class="btn btn-ghost btn-xs chat-retry-btn"
                                  onClick=${() => retryPendingMessage(pm.tempId)}>↻ Retry</button>`
                        : ""}
                </div>
              </div>
            `)}

        ${/* Agent status typing indicator (replaces simple 'sending' dot animation) */
          statusState !== "idle" && statusState !== "paused" && html`
          <div class="chat-bubble assistant chat-agent-status">
            <div class="chat-typing">
              <span class="chat-typing-dot"></span>
              <span class="chat-typing-dot"></span>
              <span class="chat-typing-dot"></span>
            </div>
            <div class="chat-agent-status-text">${statusText}</div>
          </div>
        `}
      </div>
      ${!autoScroll && messages.length > 0 && html`
        <div class="chat-jump-latest">
          <button
            class="btn btn-primary btn-sm"
            onClick=${() => {
              const el = messagesRef.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              setAutoScroll(true);
              setUnreadCount(0);
            }}
          >
            ↓ Jump to latest${unreadCount ? ` (${unreadCount})` : ""}
          </button>
        </div>
      `}

      ${!readOnly && html`
      <div class="chat-input-bar">
        ${!isActive && session?.status &&
        html`
          <button class="btn btn-primary btn-sm chat-resume-btn" onClick=${handleResume}>
            ▶ ${resumeLabel}
          </button>
        `}
        <div class="chat-input-row">
          <textarea
            ref=${inputRef}
            class="input chat-input"
            placeholder="Send a message…"
            rows="1"
            value=${input}
            onInput=${handleInput}
            onKeyDown=${handleKeyDown}
          />
          <button
            class="btn btn-primary chat-send-btn"
            disabled=${!input.trim() || sending}
            onClick=${handleSend}
          >
            ➤
          </button>
        </div>
      </div>
      `}
    </div>
  `;
}
