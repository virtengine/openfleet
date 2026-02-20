/* ─────────────────────────────────────────────────────────────
 *  Tab: Chat — ChatGPT-style session interface with slash
 *  commands, session rename, and multi-line input.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useEffect, useState, useCallback, useRef } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  SessionList,
  loadSessions,
  selectedSessionId,
  sessionsData,
  createSession,
  loadSessionMessages,
} from "../components/session-list.js";
import { ChatView } from "../components/chat-view.js";
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";

/* ─── Slash commands ─── */
const SLASH_COMMANDS = [
  { cmd: "/help", desc: "Show available commands", icon: "❓" },
  { cmd: "/status", desc: "Check orchestrator status", icon: "📊" },
  { cmd: "/health", desc: "Health check", icon: "💚" },
  { cmd: "/logs", desc: "View recent logs", icon: "📜" },
  { cmd: "/tasks", desc: "List tasks", icon: "📋" },
  { cmd: "/plan", desc: "Generate plan", icon: "📝" },
  { cmd: "/start", desc: "Start orchestrator", icon: "▶️" },
  { cmd: "/stop", desc: "Stop orchestrator", icon: "⏹️" },
  { cmd: "/pause", desc: "Pause execution", icon: "⏸️" },
  { cmd: "/resume", desc: "Resume execution", icon: "▶️" },
  { cmd: "/version", desc: "Show version info", icon: "🔢" },
  { cmd: "/hooks", desc: "Show hook status", icon: "🪝" },
  { cmd: "/sentinel", desc: "Sentinel status", icon: "🛡️" },
  { cmd: "/kanban", desc: "Open Kanban board", icon: "📌" },
  { cmd: "/deploy", desc: "Trigger deployment", icon: "🚀" },
  { cmd: "/ask", desc: "Ask the assistant", icon: "💬" },
];

/* ─── Welcome screen (no session selected) ─── */
function ChatWelcome({ onNewSession, onQuickCommand }) {
  const quickActions = [
    { label: "New Chat", icon: "💬", action: () => onNewSession() },
    { label: "Status", icon: "📊", action: () => onQuickCommand("/status") },
    { label: "Tasks", icon: "📋", action: () => onQuickCommand("/tasks") },
    { label: "Logs", icon: "📜", action: () => onQuickCommand("/logs") },
    { label: "Health", icon: "💚", action: () => onQuickCommand("/health") },
    { label: "Help", icon: "❓", action: () => onQuickCommand("/help") },
  ];

  return html`
    <div class="chat-welcome">
      <div class="chat-welcome-icon">🤖</div>
      <div class="chat-welcome-title">Welcome to Bosun</div>
      <div class="chat-welcome-subtitle">
        Select a session from the sidebar, start a new chat, or use a quick
        action below to get started.
      </div>
      <div class="chat-welcome-actions">
        ${quickActions.map(
          (a) => html`
            <button
              key=${a.label}
              class="btn btn-ghost btn-sm chat-welcome-btn"
              onClick=${a.action}
            >
              <span>${a.icon}</span> ${a.label}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

/* ─── Slash command autocomplete popup ─── */
function SlashMenu({ filter, onSelect, activeIndex }) {
  const lowerFilter = (filter || "").toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) =>
    c.cmd.toLowerCase().startsWith(lowerFilter),
  );
  if (matches.length === 0) return null;

  return html`
    <div class="slash-menu">
      ${matches.map(
        (c, i) => html`
          <div
            key=${c.cmd}
            class="slash-menu-item ${i === activeIndex ? "active" : ""}"
            onMouseDown=${(e) => {
              e.preventDefault();
              onSelect(c.cmd);
            }}
          >
            <span class="slash-menu-item-icon">${c.icon}</span>
            <span class="slash-menu-item-cmd">${c.cmd}</span>
            <span class="slash-menu-item-desc">${c.desc}</span>
          </div>
        `,
      )}
    </div>
  `;
}

/* ─── Inline session rename input ─── */
function SessionRenameInput({ value, onSave, onCancel }) {
  const inputRef = useRef(null);
  const [val, setVal] = useState(value || "");

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  function commit() {
    const trimmed = val.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    } else {
      onCancel();
    }
  }

  return html`
    <input
      ref=${inputRef}
      class="session-item-rename"
      value=${val}
      onInput=${(e) => setVal(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") onCancel();
      }}
      onBlur=${commit}
    />
  `;
}

/* ─── Main Chat Tab ─── */
export function ChatTab() {
  const sessionId = selectedSessionId.value;
  const [showArchived, setShowArchived] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashActiveIdx, setSlashActiveIdx] = useState(0);
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);

  /* ── Load sessions on mount ── */
  useEffect(() => {
    let mounted = true;
    loadSessions({ type: "primary" });
    const interval = setInterval(() => {
      if (mounted) loadSessions({ type: "primary" });
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  /* ── Auto-select first session if none ── */
  useEffect(() => {
    const sessions = sessionsData.value || [];
    if (selectedSessionId.value || sessions.length === 0) return;
    const next =
      sessions.find(
        (s) => s.status === "active" || s.status === "running",
      ) || sessions[0];
    if (next?.id) selectedSessionId.value = next.id;
  }, [sessionsData.value, selectedSessionId.value]);

  /* ── Slash command filtering ── */
  const filteredSlash = SLASH_COMMANDS.filter((c) =>
    c.cmd.toLowerCase().startsWith((slashFilter || "").toLowerCase()),
  );

  /* ── Input handling with slash command detection ── */
  function handleInputChange(e) {
    const val = e.target.value;
    setInputValue(val);

    // Auto-grow textarea
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    if (val.startsWith("/")) {
      setShowSlashMenu(true);
      setSlashFilter(val.split(/\s/)[0]); // filter on first word only
      setSlashActiveIdx(0);
    } else {
      setShowSlashMenu(false);
      setSlashFilter("");
    }
  }

  /* ── Select a slash command from popup ── */
  function selectSlashCommand(cmd) {
    setInputValue(cmd + " ");
    setShowSlashMenu(false);
    setSlashFilter("");
    if (textareaRef.current) textareaRef.current.focus();
  }

  /* ── Send message or command ── */
  async function handleSend() {
    const content = inputValue.trim();
    if (!content || sending) return;

    setShowSlashMenu(false);
    setSending(true);

    try {
      if (content.startsWith("/")) {
        // Send as slash command — show result in chat if session is active
        const resp = await apiFetch("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: content }),
        });
        const data = resp?.data;
        if (sessionId) {
          // Record command + result as chat messages so they appear in view
          const { sessionMessages } = await import("../components/session-list.js");
          const now = new Date().toISOString();
          const msgs = sessionMessages.value || [];
          const userMsg = { id: `cmd-${Date.now()}`, role: "user", content, timestamp: now };
          const resultText = data?.content || data?.error
            || (data?.readOnly ? `✅ ${content.split(/\s/)[0]} — see the relevant tab for details.` : `✅ Command executed: ${content.split(/\s/)[0]}`);
          const sysMsg = { id: `cmd-r-${Date.now()}`, role: "system", content: resultText, timestamp: now };
          sessionMessages.value = [...msgs, userMsg, sysMsg];
        } else {
          showToast("Command sent: " + content.split(/\s/)[0], "success");
        }
      } else if (sessionId) {
        // Send as message to current session
        await apiFetch(`/api/sessions/${sessionId}/message`, {
          method: "POST",
          body: JSON.stringify({ content }),
        });
        if (sessionId) loadSessionMessages(sessionId);
      } else {
        // No session — create one and send as first message
        const res = await createSession({ type: "primary", prompt: content });
        if (res?.session?.id) {
          await apiFetch(`/api/sessions/${res.session.id}/message`, {
            method: "POST",
            body: JSON.stringify({ content }),
          });
          loadSessionMessages(res.session.id);
        }
      }
    } catch (err) {
      showToast("Failed to send: " + (err.message || "Unknown error"), "error");
    } finally {
      setInputValue("");
      setSending(false);
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  }

  /* ── Keyboard handling ── */
  function handleKeyDown(e) {
    // Slash menu navigation
    if (showSlashMenu && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIdx((prev) =>
          prev < filteredSlash.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIdx((prev) =>
          prev > 0 ? prev - 1 : filteredSlash.length - 1,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectSlashCommand(filteredSlash[slashActiveIdx].cmd);
        return;
      }
      if (e.key === "Escape") {
        setShowSlashMenu(false);
        return;
      }
    }

    // Send on Enter (shift+enter = newline)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /* ── Session rename ── */
  async function saveRename(sid, newTitle) {
    try {
      await apiFetch(`/api/sessions/${sid}/rename`, {
        method: "POST",
        body: JSON.stringify({ title: newTitle }),
      });
      loadSessions();
      showToast("Session renamed", "success");
    } catch {
      showToast("Failed to rename session", "error");
    } finally {
      setRenamingSessionId(null);
    }
  }

  function cancelRename() {
    setRenamingSessionId(null);
  }

  /* ── Quick command (from welcome screen) ── */
  async function handleQuickCommand(cmd) {
    try {
      await apiFetch("/api/command", {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
      });
      showToast("Command sent: " + cmd, "success");
    } catch {
      showToast("Failed to send command", "error");
    }
  }

  /* ── Handle new session from welcome ── */
  async function handleNewSession() {
    await createSession({ type: "primary" });
  }

  const handleBack = useCallback(() => {
    selectedSessionId.value = null;
  }, []);

  /* ── Render ── */
  return html`
    <div class="session-panel">
      <div class="session-split ${sessionId ? 'has-active-session' : ''}">
        <!-- Left panel: Sessions sidebar -->
        <div class="session-pane">
          <${SessionList}
            showArchived=${showArchived}
            onToggleArchived=${setShowArchived}
            defaultType="primary"
            renamingSessionId=${renamingSessionId}
            onStartRename=${(sid) => setRenamingSessionId(sid)}
            onSaveRename=${saveRename}
            onCancelRename=${cancelRename}
          />
        </div>

        <!-- Right panel: Chat area -->
        <div class="session-detail">
          ${sessionId &&
          html`
            <div class="chat-mobile-header">
              <button class="session-back-btn" onClick=${handleBack}>
                ← Back
              </button>
              <span class="chat-mobile-title">${
                (sessionsData.value || []).find(s => s.id === sessionId)?.title
                || "Chat"
              }</span>
            </div>
          `}
          ${sessionId
            ? html`<${ChatView} sessionId=${sessionId} readOnly embedded />`
            : html`
                <${ChatWelcome}
                  onNewSession=${handleNewSession}
                  onQuickCommand=${handleQuickCommand}
                />
              `}

          <!-- Bottom input area (always visible) -->
          <div class="chat-input-area">
            ${showSlashMenu &&
            html`
              <${SlashMenu}
                filter=${slashFilter}
                onSelect=${selectSlashCommand}
                activeIndex=${slashActiveIdx}
              />
            `}
            <div class="chat-input-wrapper">
              <textarea
                ref=${textareaRef}
                class="chat-textarea"
                placeholder=${sessionId
                  ? 'Send a message… (type "/" for commands)'
                  : 'Start a new chat or type "/" for commands'}
                rows="1"
                value=${inputValue}
                onInput=${handleInputChange}
                onKeyDown=${handleKeyDown}
              />
              <button
                class="chat-send-btn"
                disabled=${!inputValue.trim() || sending}
                onClick=${handleSend}
                title="Send (Enter)"
              >
                ${sending ? "⏳" : "➤"}
              </button>
            </div>
            <div class="chat-input-hint">
              <span>Shift+Enter for new line</span>
              <span>Type / for commands</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
