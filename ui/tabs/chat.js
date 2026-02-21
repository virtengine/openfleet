/* ─────────────────────────────────────────────────────────────
 *  Tab: Chat — ChatGPT-style session interface with agent mode
 *  selector, SDK command passthrough, optimistic rendering,
 *  offline queue, and streaming status indicators.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useEffect, useState, useCallback, useRef, useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  SessionList,
  loadSessions,
  selectedSessionId,
  sessionsData,
  createSession,
  loadSessionMessages,
  archiveSession,
  resumeSession,
} from "../components/session-list.js";
import { ChatView } from "../components/chat-view.js";
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";
import {
  ChatInputToolbar,
  loadAvailableAgents,
  agentMode,
  activeAgent,
  activeAgentInfo,
} from "../components/agent-selector.js";
import {
  addPendingMessage,
  confirmMessage,
  rejectMessage,
  markUserMessageSent,
  sendOrQueue,
  offlineQueueSize,
} from "../modules/streaming.js";

/* ─── Bosun commands (always available) ─── */
const BOSUN_COMMANDS = [
  { cmd: "/help", desc: "Show available commands", icon: "❓", source: "bosun" },
  { cmd: "/status", desc: "Check orchestrator status", icon: "📊", source: "bosun" },
  { cmd: "/health", desc: "Health check", icon: "💚", source: "bosun" },
  { cmd: "/logs", desc: "View recent logs", icon: "📜", source: "bosun" },
  { cmd: "/tasks", desc: "List tasks", icon: "📋", source: "bosun" },
  { cmd: "/plan", desc: "Generate plan", icon: "📝", source: "bosun" },
  { cmd: "/start", desc: "Start orchestrator", icon: "▶️", source: "bosun" },
  { cmd: "/stop", desc: "Stop orchestrator", icon: "⏹️", source: "bosun" },
  { cmd: "/pause", desc: "Pause execution", icon: "⏸️", source: "bosun" },
  { cmd: "/resume", desc: "Resume execution", icon: "▶️", source: "bosun" },
  { cmd: "/version", desc: "Show version info", icon: "🔢", source: "bosun" },
  { cmd: "/hooks", desc: "Show hook status", icon: "🪝", source: "bosun" },
  { cmd: "/sentinel", desc: "Sentinel status", icon: "🛡️", source: "bosun" },
  { cmd: "/kanban", desc: "Open Kanban board", icon: "📌", source: "bosun" },
  { cmd: "/deploy", desc: "Trigger deployment", icon: "🚀", source: "bosun" },
  { cmd: "/ask", desc: "Ask the assistant", icon: "💬", source: "bosun" },
];

/* ─── SDK commands (dynamic based on active agent) ─── */
const SDK_COMMAND_META = {
  "/compact": { desc: "Compact conversation context", icon: "🗜️" },
  "/context": { desc: "Show context window usage", icon: "📏" },
  "/mcp": { desc: "MCP server status", icon: "🔌" },
  "/model": { desc: "Show/change model", icon: "🧠" },
  "/clear": { desc: "Clear agent session", icon: "🧹" },
};

/** Merge Bosun + SDK commands based on active agent capabilities */
function getSlashCommands() {
  const info = activeAgentInfo.value;
  const sdkCmds = info?.capabilities?.sdkCommands || [];
  const sdkEntries = sdkCmds
    .filter((cmd) => !BOSUN_COMMANDS.some((b) => b.cmd === cmd))
    .map((cmd) => ({
      cmd,
      desc: SDK_COMMAND_META[cmd]?.desc || `SDK: ${cmd}`,
      icon: SDK_COMMAND_META[cmd]?.icon || "⚡",
      source: "sdk",
    }));
  return [...BOSUN_COMMANDS, ...sdkEntries];
}

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
function SlashMenu({ filter, onSelect, activeIndex, commands }) {
  const lowerFilter = (filter || "").toLowerCase();
  const matches = (commands || getSlashCommands()).filter((c) =>
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
            ${c.source === "sdk" && html`<span class="slash-menu-item-badge">SDK</span>`}
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
  const [isMobile, setIsMobile] = useState(() => {
    try {
      return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false;
    } catch {
      return false;
    }
  });
  const [isDesktop, setIsDesktop] = useState(() => {
    try {
      return globalThis.matchMedia?.("(min-width: 1200px)")?.matches ?? false;
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(() => {
    return !selectedSessionId.value && (globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false);
  });
  const [focusMode, setFocusMode] = useState(() => {
    try {
      return localStorage.getItem("ve-chat-focus") === "true";
    } catch {
      return false;
    }
  });
  const textareaRef = useRef(null);

  /* ── Load sessions + agents on mount ── */
  useEffect(() => {
    let mounted = true;
    loadSessions({ type: "primary" });
    loadAvailableAgents();
    const interval = setInterval(() => {
      if (mounted) loadSessions({ type: "primary" });
    }, 5000);
    // Refresh agent list less frequently
    const agentInterval = setInterval(() => {
      if (mounted) loadAvailableAgents();
    }, 30000);
    return () => {
      mounted = false;
      clearInterval(interval);
      clearInterval(agentInterval);
    };
  }, []);

  /* ── Track mobile viewport to avoid auto-select loops ── */
  useEffect(() => {
    const mq = globalThis.matchMedia?.("(max-width: 768px)");
    if (!mq) return;
    const handler = (e) => setIsMobile(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    const mq = globalThis.matchMedia?.("(min-width: 1200px)");
    if (!mq) return;
    const handler = (e) => setIsDesktop(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    if (focusMode) {
      document.documentElement.dataset.chatFocus = "true";
    } else {
      delete document.documentElement.dataset.chatFocus;
    }
    try {
      localStorage.setItem("ve-chat-focus", String(focusMode));
    } catch {
      /* ignore storage errors */
    }
    return () => {
      delete document.documentElement.dataset.chatFocus;
    };
  }, [focusMode]);

  /* ── Auto-select first session if none ── */
  useEffect(() => {
    if (isMobile) return;
    const sessions = sessionsData.value || [];
    if (selectedSessionId.value || sessions.length === 0) return;
    const next =
      sessions.find(
        (s) => s.status === "active" || s.status === "running",
      ) || sessions[0];
    if (next?.id) selectedSessionId.value = next.id;
  }, [sessionsData.value, selectedSessionId.value, isMobile]);

  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
      return;
    }
    if (!selectedSessionId.value) {
      setDrawerOpen(true);
    }
  }, [isMobile, selectedSessionId.value]);

  /* ── Slash command filtering ── */
  const allCommands = getSlashCommands();
  const filteredSlash = allCommands.filter((c) =>
    c.cmd.toLowerCase().startsWith((slashFilter || "").toLowerCase()),
  );

  /* ── Determine if a command is an SDK command ── */
  function isSdkCommand(cmdBase) {
    const info = activeAgentInfo.value;
    const sdkCmds = info?.capabilities?.sdkCommands || [];
    return sdkCmds.includes(cmdBase);
  }

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
        const cmdBase = content.split(/\s/)[0].toLowerCase();
        const cmdArgs = content.slice(cmdBase.length).trim();

        if (isSdkCommand(cmdBase)) {
          // Forward to agent SDK
          const resp = await apiFetch("/api/agents/sdk-command", {
            method: "POST",
            body: JSON.stringify({ command: cmdBase, args: cmdArgs }),
          });
          const resultText = resp?.result || resp?.data || `✅ SDK command executed: ${cmdBase}`;
          if (sessionId) {
            const { sessionMessages } = await import("../components/session-list.js");
            const now = new Date().toISOString();
            const msgs = sessionMessages.value || [];
            const userMsg = { id: `sdk-${Date.now()}`, role: "user", content, timestamp: now };
            const sysMsg = { id: `sdk-r-${Date.now()}`, role: "system", content: typeof resultText === "string" ? resultText : JSON.stringify(resultText), timestamp: now };
            sessionMessages.value = [...msgs, userMsg, sysMsg];
          } else {
            showToast("SDK command: " + cmdBase, "success");
          }
        } else {
          // Bosun command
          const resp = await apiFetch("/api/command", {
            method: "POST",
            body: JSON.stringify({ command: content }),
          });
          const data = resp?.data;
          if (sessionId) {
            const { sessionMessages } = await import("../components/session-list.js");
            const now = new Date().toISOString();
            const msgs = sessionMessages.value || [];
            const userMsg = { id: `cmd-${Date.now()}`, role: "user", content, timestamp: now };
            const resultText = data?.content || data?.error
              || (data?.readOnly ? `✅ ${cmdBase} — see the relevant tab for details.` : `✅ Command executed: ${cmdBase}`);
            const sysMsg = { id: `cmd-r-${Date.now()}`, role: "system", content: resultText, timestamp: now };
            sessionMessages.value = [...msgs, userMsg, sysMsg];
          } else {
            showToast("Command sent: " + cmdBase, "success");
          }
        }
      } else if (sessionId) {
        // Send as message to current session with optimistic rendering
        const tempId = addPendingMessage(sessionId, content);
        markUserMessageSent(activeAgent.value);

        // Use sendOrQueue for offline resilience
        const sendFn = async (sid, msg) => {
          await apiFetch(`/api/sessions/${sid}/message`, {
            method: "POST",
            body: JSON.stringify({ content: msg, mode: agentMode.value }),
          });
        };

        try {
          await sendOrQueue(sessionId, content, sendFn);
          confirmMessage(tempId);
        } catch (err) {
          rejectMessage(tempId, err.message || "Send failed");
          throw err;
        }

        loadSessionMessages(sessionId);
      } else {
        // No session — create one with current agent/mode, then send first message
        const res = await createSession({
          type: "primary",
          prompt: content,
          agent: activeAgent.value,
          mode: agentMode.value,
        });
        const newId = res?.session?.id;
        if (newId) {
          const tempId = addPendingMessage(newId, content);
          markUserMessageSent(activeAgent.value);

          try {
            await apiFetch(`/api/sessions/${newId}/message`, {
              method: "POST",
              body: JSON.stringify({ content, mode: agentMode.value }),
            });
            confirmMessage(tempId);
          } catch (err) {
            rejectMessage(tempId, err.message || "Send failed");
          }

          loadSessionMessages(newId);
        }
      }
    } catch (err) {
      showToast("Failed to send: " + (err.message || "Unknown error"), "error");
    } finally {
      setInputValue("");
      setSending(false);
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
    if (isMobile) {
      setDrawerOpen(true);
      return;
    }
    selectedSessionId.value = null;
  }, [isMobile]);

  const handleSelectSession = useCallback(() => {
    if (isMobile) setDrawerOpen(false);
  }, [isMobile]);

  const activeSession = useMemo(
    () => (sessionsData.value || []).find((s) => s.id === sessionId) || null,
    [sessionsData.value, sessionId],
  );
  const sessionTitle = activeSession?.title || activeSession?.taskId || "Session";
  const sessionMeta = [activeSession?.type, activeSession?.status]
    .filter(Boolean)
    .join(" · ");

  /* ── Render ── */
  return html`
    <div class="session-panel">
      <div
        class="session-split ${sessionId ? 'has-active-session' : ''} ${drawerOpen ? 'drawer-open' : ''}"
        data-mobile=${isMobile ? "true" : "false"}
      >
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
            onSelect=${handleSelectSession}
          />
        </div>

        <!-- Right panel: Chat area -->
        <div class="session-detail">
          ${sessionId &&
          html`
            <div class="chat-shell-header">
              <div class="chat-shell-inner">
                <button class="session-drawer-btn" onClick=${handleBack}>
                  ☰ Sessions
                </button>
                <div class="chat-shell-title">
                  <div class="chat-shell-name">${sessionTitle}</div>
                  <div class="chat-shell-meta">${sessionMeta || "Session"}</div>
                </div>
                <div class="chat-shell-actions">
                  ${isDesktop &&
                  html`
                    <button
                      class="btn btn-ghost btn-sm"
                      onClick=${() => setFocusMode((prev) => !prev)}
                      title=${focusMode ? "Exit focus mode" : "Enter focus mode"}
                    >
                      ${focusMode ? "Exit Focus" : "Focus"}
                    </button>
                  `}
                  ${activeSession?.status === "archived"
                    ? html`
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick=${() => resumeSession(activeSession.id)}
                        >
                          Restore
                        </button>
                      `
                    : html`
                        <button
                          class="btn btn-ghost btn-sm"
                          onClick=${() => archiveSession(activeSession.id)}
                        >
                          Archive
                        </button>
                      `}
                </div>
              </div>
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
                commands=${allCommands}
              />
            `}
            <${ChatInputToolbar} />
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
              ${offlineQueueSize.value > 0 && html`
                <span class="chat-offline-badge">📤 ${offlineQueueSize.value} queued</span>
              `}
            </div>
          </div>
        </div>
      </div>
      ${isMobile &&
      html`
        <div
          class="session-drawer-backdrop ${drawerOpen ? "open" : ""}"
          onClick=${() => setDrawerOpen(false)}
        ></div>
      `}
    </div>
  `;
}
