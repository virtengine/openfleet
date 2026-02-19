/* ─────────────────────────────────────────────────────────────
 *  Component: Chat View — ChatGPT-style message interface
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
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

const html = htm.bind(h);

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

/* ─── Code block copy button ─── */
function CodeBlock({ code }) {
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
}

/* ─── Render message content with code block + markdown support ─── */
function MessageContent({ text }) {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return html`${parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3).replace(/^\w+\n/, "");
      return html`<${CodeBlock} key=${i} code=${code} />`;
    }
    return html`<div key=${i} class="md-rendered" dangerouslySetInnerHTML=${{ __html: renderMarkdown(part) }} />`;
  })}`;
}

/* ─── Stream helpers ─── */
function categorizeMessage(msg) {
  const type = (msg?.type || "").toLowerCase();
  if (type === "tool_call") return "tool";
  if (type === "tool_result" || type === "tool_output") return "result";
  if (type === "error" || type === "stream_error") return "error";
  return "message";
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

/* ─── Chat View component ─── */
export function ChatView({ sessionId, readOnly = false }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState({
    tool: false,
    result: false,
    error: false,
  });
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const messages = sessionMessages.value || [];

  const session = (sessionsData.value || []).find((s) => s.id === sessionId);
  const isActive =
    session?.status === "active" || session?.status === "running";
  const resumeLabel =
    session?.status === "archived" ? "Unarchive" : "Resume Session";

  const activeFilters = Object.entries(filters)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);

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

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    await loadSessionMessages(sessionId).finally(() => setLoading(false));
  }, [sessionId]);

  /* Load messages on mount and poll while active */
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    if (!paused) {
      setLoading(true);
      loadSessionMessages(sessionId).finally(() => {
        if (active) setLoading(false);
      });
    } else {
      setLoading(false);
    }

    const interval = setInterval(() => {
      if (active && !paused) loadSessionMessages(sessionId);
    }, 3000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [sessionId, session?.status, paused]);

  /* Auto-scroll to bottom */
  useEffect(() => {
    if (!paused && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages.length, paused]);

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
    sessionMessages.value = [...sessionMessages.value, optimistic];
    setInput("");
    setSending(true);

    try {
      await apiFetch(`/api/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
      await loadSessionMessages(sessionId);
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
      await loadSessionMessages(sessionId);
    } catch {
      showToast("Failed to resume session", "error");
    }
  }, [sessionId]);

  const handleArchive = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}/archive`, { method: "POST" });
      showToast("Session archived", "success");
      await loadSessions();
      await loadSessionMessages(sessionId);
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
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
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
    <div class="chat-view">
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

      <div class="chat-messages" ref=${messagesRef}>
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
        ${filteredMessages.map((msg) => {
          const isTool =
            msg.type === "tool_call" || msg.type === "tool_result";
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
              ? msg.type === "tool_call"
                ? "TOOL CALL"
                : "TOOL RESULT"
              : isError
                ? "ERROR"
                : null;
          return html`
            <div
              key=${msg.id || msg.timestamp}
              class="chat-bubble ${bubbleClass}"
            >
              ${role === "system" && !isTool
                ? html`<div class="chat-system-text">${msg.content}</div>`
                : html`
                    ${label
                      ? html`<div class="chat-bubble-label">${label}</div>`
                      : null}
                    <div class="chat-bubble-content">
                      <${MessageContent} text=${msg.content} />
                    </div>
                    <div class="chat-bubble-time">
                      ${msg.timestamp ? formatRelative(msg.timestamp) : ""}
                    </div>
                  `}
            </div>
          `;
        })}
        ${sending && html`
          <div class="chat-bubble assistant">
            <div class="chat-typing">
              <span class="chat-typing-dot"></span>
              <span class="chat-typing-dot"></span>
              <span class="chat-typing-dot"></span>
            </div>
          </div>
        `}
      </div>

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
