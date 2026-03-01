/* ─────────────────────────────────────────────────────────────
 *  Tab: Chat — ChatGPT-style session interface with agent mode
 *  selector, SDK command passthrough, optimistic rendering,
 *  offline queue, and streaming status indicators.
 * ────────────────────────────────────────────────────────────── */
import { h, Component } from "preact";
import { useEffect, useState, useCallback, useRef, useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

/* ─── Inner error boundary for complex sub-components ─── */
class ChatSafeBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[ChatSafeBoundary] Caught error in", this.props.label || "component", ":", error, info);
  }
  render() {
    if (this.state.error) {
      const retry = () => this.setState({ error: null });
      return html`
        <div class="chat-error-inline" style="padding:16px;text-align:center;color:var(--text-secondary,#999);opacity:0.8;">
          <span style="font-size:18px;">${resolveIcon("alert")}</span>
          <span style="margin-left:8px;font-size:12px;">
            ${this.props.label || "Component"} failed to render.
          </span>
          <button class="btn btn-ghost btn-xs" style="margin-left:8px;" onClick=${retry}>
            Retry
          </button>
        </div>
      `;
    }
    return this.props.children;
  }
}

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
import { routeParams, setRouteParams } from "../modules/router.js";
import { ChatView } from "../components/chat-view.js";
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";
import { VoiceMicButton, requestVoiceModeOpen } from "../modules/voice.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  ChatInputToolbar,
  loadAvailableAgents,
  agentMode,
  activeAgent,
  activeAgentInfo,
  availableAgents,
  yoloMode,
  selectedModel,
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
  { cmd: "/help", desc: "Show available commands", icon: "help", source: "bosun" },
  { cmd: "/status", desc: "Check orchestrator status", icon: "chart", source: "bosun" },
  { cmd: "/health", desc: "Health check", icon: "heart", source: "bosun" },
  { cmd: "/logs", desc: "View recent logs", icon: "file", source: "bosun" },
  { cmd: "/tasks", desc: "List tasks", icon: "clipboard", source: "bosun" },
  { cmd: "/plan", desc: "Generate plan", icon: "edit", source: "bosun" },
  { cmd: "/start", desc: "Start orchestrator", icon: "play", source: "bosun" },
  { cmd: "/stop", desc: "Stop orchestrator", icon: "stop", source: "bosun" },
  { cmd: "/pause", desc: "Pause execution", icon: "pause", source: "bosun" },
  { cmd: "/resume", desc: "Resume execution", icon: "play", source: "bosun" },
  { cmd: "/version", desc: "Show version info", icon: "hash", source: "bosun" },
  { cmd: "/hooks", desc: "Show hook status", icon: "link", source: "bosun" },
  { cmd: "/sentinel", desc: "Sentinel status", icon: "shield", source: "bosun" },
  { cmd: "/kanban", desc: "Open Kanban board", icon: "pin", source: "bosun" },
  { cmd: "/deploy", desc: "Trigger deployment", icon: "rocket", source: "bosun" },
  { cmd: "/ask", desc: "Ask the assistant", icon: "chat", source: "bosun" },
  { cmd: "/agent", desc: "Send message in agent mode", icon: "bot", source: "bosun" },
  { cmd: "/web", desc: "Send message in web mode", icon: "globe", source: "bosun" },
  { cmd: "/instant", desc: "Send message in instant mode", icon: "zap", source: "bosun" },
];

const MESSAGE_MODE_COMMANDS = Object.freeze({
  "/ask": "ask",
  "/agent": "agent",
  "/plan": "plan",
  "/web": "web",
  "/instant": "instant",
});

/* ─── SDK commands (dynamic based on active agent) ─── */
const SDK_COMMAND_META = {
  "/compact": { desc: "Compact conversation context", icon: "filter" },
  "/context": { desc: "Show context window usage", icon: "ruler" },
  "/mcp": { desc: "MCP server status", icon: "plug" },
  "/model": { desc: "Show/change model", icon: "cpu" },
  "/clear": { desc: "Clear agent session", icon: "trash" },
};

/** Merge Bosun + SDK commands based on active agent capabilities.
 *  Uses .peek() to avoid subscribing render callers to the signal. */
function getSlashCommands() {
  const info = activeAgentInfo.peek();
  const sdkCmds = info?.capabilities?.sdkCommands || [];
  const sdkEntries = sdkCmds
    .filter((cmd) => !BOSUN_COMMANDS.some((b) => b.cmd === cmd))
    .map((cmd) => ({
      cmd,
      desc: SDK_COMMAND_META[cmd]?.desc || `SDK: ${cmd}`,
      icon: SDK_COMMAND_META[cmd]?.icon || "zap",
      source: "sdk",
    }));
  return [...BOSUN_COMMANDS, ...sdkEntries];
}

/* ─── Welcome screen (no session selected) ─── */
function ChatWelcome({ onNewSession, onQuickCommand }) {
  const quickActions = [
    { label: "New Chat", icon: "chat", action: () => onNewSession() },
    { label: "Status", icon: "chart", action: () => onQuickCommand("/status") },
    { label: "Tasks", icon: "clipboard", action: () => onQuickCommand("/tasks") },
    { label: "Logs", icon: "file", action: () => onQuickCommand("/logs") },
    { label: "Health", icon: "heart", action: () => onQuickCommand("/health") },
    { label: "Help", icon: "help", action: () => onQuickCommand("/help") },
  ];

  return html`
    <div class="chat-welcome">
      <div class="chat-welcome-icon">${resolveIcon("bot")}</div>
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
              <span>${resolveIcon(a.icon) || a.icon}</span> ${a.label}
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
            <span class="slash-menu-item-icon">${resolveIcon(c.icon) || c.icon}</span>
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
  const [chatError, setChatError] = useState(null);

  // Wrap the entire signal read in try/catch to prevent crash on corrupt signal state
  let sessionId = null;
  try {
    sessionId = selectedSessionId.value;
  } catch (err) {
    console.error("[ChatTab] Failed to read selectedSessionId:", err);
    if (!chatError) setChatError(err.message || "Signal read error");
  }

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
  const sendMenuRef = useRef(null);
  const messageQueueRef = useRef([]);
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [stoppingAgent, setStoppingAgent] = useState(false);
  const routeSessionId = String(routeParams.value?.sessionId || "").trim();

  /* ── Load sessions + agents on mount ── */
  useEffect(() => {
    let mounted = true;
    // Stagger initial loads to avoid signal cascade storm —
    // each API response updates a signal → triggers re-render.
    // Loading them sequentially gives each render time to settle.
    (async () => {
      try {
        await loadSessions({ type: "primary" });
      } catch { /* handled internally */ }
      if (!mounted) return;
      // Small delay before loading agents to let session render settle
      await new Promise(r => setTimeout(r, 50));
      if (!mounted) return;
      try {
        await loadAvailableAgents();
      } catch { /* handled internally */ }
    })();
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
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const root = document.documentElement;
    const viewport = window.visualViewport;

    const updateKeyboardOffset = () => {
      if (!viewport) {
        root.style.setProperty("--chat-keyboard-offset", "0px");
        return;
      }

      const keyboardOffset = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
      );
      root.style.setProperty("--chat-keyboard-offset", `${keyboardOffset}px`);
      if (keyboardOffset > 0) {
        root.setAttribute("data-chat-keyboard-open", "true");
      } else {
        root.removeAttribute("data-chat-keyboard-open");
      }
    };

    updateKeyboardOffset();

    if (!viewport) return () => {
      root.style.setProperty("--chat-keyboard-offset", "0px");
      root.removeAttribute("data-chat-keyboard-open");
    };

    viewport.addEventListener("resize", updateKeyboardOffset);
    viewport.addEventListener("scroll", updateKeyboardOffset);
    window.addEventListener("orientationchange", updateKeyboardOffset);

    return () => {
      viewport.removeEventListener("resize", updateKeyboardOffset);
      viewport.removeEventListener("scroll", updateKeyboardOffset);
      window.removeEventListener("orientationchange", updateKeyboardOffset);
      root.style.setProperty("--chat-keyboard-offset", "0px");
      root.removeAttribute("data-chat-keyboard-open");
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
  /* NOTE: We use an effect subscription on the signal instead of putting
     signal.value in the deps array.  Putting .value in deps causes Preact
     to re-run the effect on every signal update AND re-render the component
     simultaneously, creating a cascade storm that can crash the mini-app.
     Instead we subscribe with effect() and clean up on unmount. */
  useEffect(() => {
    if (isMobile) return undefined;
    // Use a short debounce to batch signal cascades during initial load
    let debounceTimer = null;
    const tryAutoSelect = () => {
      try {
        const sessions = sessionsData.value || [];
        if (selectedSessionId.value || sessions.length === 0) return;
        const next =
          sessions.find(
            (s) => s.status === "active" || s.status === "running",
          ) || sessions[0];
        if (next?.id) selectedSessionId.value = next.id;
      } catch (err) {
        console.warn("[ChatTab] Auto-select error:", err);
      }
    };
    // Run once immediately for SSR / pre-loaded data
    tryAutoSelect();
    // Then watch for changes via polling (avoids signal dep cascade)
    const interval = setInterval(tryAutoSelect, 1000);
    return () => {
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
      return;
    }
    // Check signal value outside deps to avoid cascade
    try {
      if (!selectedSessionId.value) {
        setDrawerOpen(true);
      }
    } catch { /* signal read error - ignore */ }
  }, [isMobile]);

  useEffect(() => {
    if (!routeSessionId) return;
    if (sessionId === routeSessionId) return;
    selectedSessionId.value = routeSessionId;
  }, [routeSessionId]);

  useEffect(() => {
    if (sessionId) {
      setRouteParams({ sessionId }, { replace: true, skipGuard: true });
    } else {
      setRouteParams({}, { replace: true, skipGuard: true });
    }
  }, [sessionId]);

  /* ── Auto-focus textarea when switching sessions (desktop only) ── */
  useEffect(() => {
    if (!sessionId || isMobile) return;
    // Delay focus to let the ChatView mount first
    const timer = setTimeout(() => {
      if (textareaRef.current) textareaRef.current.focus();
    }, 150);
    return () => clearTimeout(timer);
  }, [sessionId, isMobile]);

  /* ── Slash command filtering ──
     Use useMemo with no signal deps to avoid subscribing ChatTab to
     activeAgentInfo. The commands list only matters when the user is
     actively typing, and the input handler re-renders anyway. */
  const allCommands = useMemo(() => getSlashCommands(), []);
  const filteredSlash = allCommands.filter((c) =>
    c.cmd.toLowerCase().startsWith((slashFilter || "").toLowerCase()),
  );

  /* ── Determine if a command is an SDK command ── */
  function isSdkCommand(cmdBase) {
    const info = activeAgentInfo.peek();
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
  async function handleSend(explicitContent) {
    const content = (typeof explicitContent === "string" ? explicitContent : inputValue).trim();
    if (!content || sending) return;

    setShowSlashMenu(false);
    setSending(true);

    const cmdBase = content.startsWith("/") ? content.split(/\s/)[0].toLowerCase() : "";
    const cmdArgs = cmdBase ? content.slice(cmdBase.length).trim() : "";
    const modeOverride = MESSAGE_MODE_COMMANDS[cmdBase] || null;
    const asModeMessage = Boolean(modeOverride && cmdArgs);
    const outboundContent = asModeMessage ? cmdArgs : content;
    const outboundMode = modeOverride || agentMode.value;

    try {
      if (content.startsWith("/") && !asModeMessage) {
        if (isSdkCommand(cmdBase)) {
          // Forward to agent SDK
          const resp = await apiFetch("/api/agents/sdk-command", {
            method: "POST",
            body: JSON.stringify({
              command: cmdBase,
              args: cmdArgs,
              sessionId: sessionId || undefined,
            }),
          });
          const resultText = resp?.result || resp?.data || `:check: SDK command executed: ${cmdBase}`;
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
              || (data?.readOnly ? `:check: ${cmdBase} — see the relevant tab for details.` : `:check: Command executed: ${cmdBase}`);
            const sysMsg = { id: `cmd-r-${Date.now()}`, role: "system", content: resultText, timestamp: now };
            sessionMessages.value = [...msgs, userMsg, sysMsg];
          } else {
            showToast("Command sent: " + cmdBase, "success");
          }
        }
      } else if (sessionId) {
        // Send as message to current session with optimistic rendering
        const tempId = addPendingMessage(sessionId, outboundContent);
        markUserMessageSent(activeAgent.value, sessionId);

        // Use sendOrQueue for offline resilience
          const sendFn = async (sid, msg) => {
            await apiFetch(`/api/sessions/${encodeURIComponent(sid)}/message`, {
              method: "POST",
              body: JSON.stringify({ content: msg, mode: outboundMode, yolo: yoloMode.peek(), model: selectedModel.value || undefined }),
            });
          };

        try {
          await sendOrQueue(sessionId, outboundContent, sendFn);
          confirmMessage(tempId);
        } catch (err) {
          rejectMessage(tempId, err.message || "Send failed");
          throw err;
        }

        loadSessionMessages(sessionId, { limit: 50 });
      } else {
        // No session — create one with current agent/mode, then send first message
        const res = await createSession({
          type: "primary",
          prompt: outboundContent,
          agent: activeAgent.value,
          mode: outboundMode,
          yolo: yoloMode.peek(),
          model: selectedModel.value || undefined,
        });
        const newId = res?.session?.id;
        if (newId) {
          const tempId = addPendingMessage(newId, outboundContent);
          markUserMessageSent(activeAgent.value, newId);

          try {
            await apiFetch(`/api/sessions/${encodeURIComponent(newId)}/message`, {
              method: "POST",
              body: JSON.stringify({ content: outboundContent, mode: outboundMode, yolo: yoloMode.peek(), model: selectedModel.value || undefined }),
            });
            confirmMessage(tempId);
          } catch (err) {
            rejectMessage(tempId, err.message || "Send failed");
          }

          loadSessionMessages(newId, { limit: 50 });
        }
      }
    } catch (err) {
      showToast("Failed to send: " + (err.message || "Unknown error"), "error");
    } finally {
      if (typeof explicitContent !== "string") setInputValue("");
      setSending(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  }

  /* ── Stop agent ── */
  async function handleStop() {
    if (stoppingAgent) return;
    setStoppingAgent(true);
    try {
      const activeId = String(activeAgent.peek() || "").trim();
      const optimisticMarkIdle = () => {
        if (!activeId) return;
        const list = Array.isArray(availableAgents.peek()) ? availableAgents.peek() : [];
        if (!list.length) return;
        let changed = false;
        const next = list.map((agent) => {
          if (agent?.id !== activeId || agent?.busy === false) return agent;
          changed = true;
          return { ...agent, busy: false };
        });
        if (changed) availableAgents.value = next;
      };

      if (sessionId) {
        const stopResult = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (stopResult?.stopped) {
          optimisticMarkIdle();
          showToast("Stopped current agent turn", "info");
        } else {
          showToast("No active agent turn to stop", "info");
          setStoppingAgent(false);
          return;
        }
      } else {
        await apiFetch("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "/stop" }),
        });
        optimisticMarkIdle();
        showToast("Agent stopped", "info");
      }

      try { await loadAvailableAgents(); } catch { /* best effort */ }
    } catch (err) {
      setStoppingAgent(false);
      showToast("Stop failed: " + (err.message || "Unknown error"), "error");
    }
  }

  /* ── Stop then send ── */
  async function handleStopAndSend() {
    setShowSendMenu(false);
    await handleStop();
    await handleSend();
  }

  /* ── Add message to queue for delivery after current task ── */
  function handleAddToQueue() {
    const content = inputValue.trim();
    if (!content) return;
    setShowSendMenu(false);
    messageQueueRef.current.push(content);
    setQueueCount(messageQueueRef.current.length);
    setInputValue("");
    showToast(`Message queued (${messageQueueRef.current.length} pending)`, "success");
  }

  /* ── Steer with message (send to running session) ── */
  async function handleSteerWithMessage() {
    setShowSendMenu(false);
    await handleSend();
  }

  /* ── Auto-send queued messages when agent becomes free ── */
  useEffect(() => {
    if (!sending && messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current.shift();
      setQueueCount(messageQueueRef.current.length);
      handleSend(next);
    }
  }, [sending]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Close send menu when clicking outside ── */
  useEffect(() => {
    if (!showSendMenu) return;
    function handleOutside(e) {
      if (sendMenuRef.current && !sendMenuRef.current.contains(e.target)) {
        setShowSendMenu(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showSendMenu]);

  // Clear one-shot stop UI lock as soon as the selected agent reports idle.
  useEffect(() => {
    if (!stoppingAgent) return;
    if (!activeAgentInfo.value?.busy) {
      setStoppingAgent(false);
    }
  }, [stoppingAgent, activeAgentInfo.value?.busy]);

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

    // Alt+Enter = Add to Queue
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      handleAddToQueue();
      return;
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
        await apiFetch(`/api/sessions/${encodeURIComponent(sid)}/rename`, {
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

  const openMeetingRoom = useCallback(
    (call = "voice") => {
      requestVoiceModeOpen({
        call: call === "video" ? "video" : "voice",
        sessionId: sessionId || undefined,
        initialVisionSource: call === "video" ? "camera" : null,
        executor: activeAgent.value || undefined,
        mode: agentMode.value || undefined,
        model: selectedModel.value || undefined,
      });
    },
    [sessionId],
  );

  /* ── Show/expand sessions: on mobile toggles drawer, on desktop fires rail-expand event ── */
  const handleShowSessions = useCallback(() => {
    if (isMobile) {
      setDrawerOpen(true);
    } else if (isDesktop) {
      globalThis.dispatchEvent?.(new CustomEvent("ve:expand-rail"));
    } else {
      // Tablet: toggle the session-pane drawer
      setDrawerOpen((v) => !v);
    }
  }, [isMobile, isDesktop]);

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

  const activeSession = useMemo(() => {
    try {
      return (sessionsData.peek() || []).find((s) => s.id === sessionId) || null;
    } catch {
      return null;
    }
  }, [sessionId]);
  const sessionTitle = activeSession?.title || activeSession?.taskId || "Session";
  const sessionMeta = [activeSession?.type, activeSession?.status]
    .filter(Boolean)
    .join(" · ");

  /* ── Render ── */

  // If we hit a critical error during signal reads, show recovery UI
  if (chatError) {
    return html`
      <div class="session-panel" style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;">
        <div style="text-align:center;color:var(--text-secondary,#999);">
          <div style="font-size:28px;margin-bottom:12px;">${resolveIcon("alert")}</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:8px;">Chat failed to load</div>
          <div style="font-size:12px;opacity:0.7;margin-bottom:16px;">${chatError}</div>
          <button class="btn btn-primary btn-sm" onClick=${() => setChatError(null)}>Retry</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="session-panel">
      <div
        class="session-split ${sessionId ? 'has-active-session' : ''} ${drawerOpen ? 'drawer-open' : ''}"
        data-mobile=${isMobile ? "true" : "false"}
      >
        <!-- Left panel: Sessions sidebar -->
        <div class="session-pane">
          <${ChatSafeBoundary} label="Session List">
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
          <//>
        </div>

        <!-- Right panel: Chat area -->
        <div class="session-detail">
          ${sessionId &&
          html`
            <div class="chat-shell-header">
              <div class="chat-shell-inner">
                <!-- Sessions toggle: shown on mobile always; on desktop only when rail is collapsed (CSS-controlled) -->
                <button class="session-drawer-btn session-drawer-btn-rail" onClick=${handleShowSessions}>
                  ${iconText(":menu: Sessions")}
                </button>
                <div class="chat-shell-title">
                  <div class="chat-shell-name">${sessionTitle}</div>
                  <div class="chat-shell-meta">${sessionMeta || "Session"}</div>
                </div>
                <div class="chat-shell-actions">
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() => openMeetingRoom("voice")}
                    title="Start voice meeting for this session"
                  >
                    <span class="btn-icon">${resolveIcon("phone")}</span>
                    Call
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() => openMeetingRoom("video")}
                    title="Start video meeting for this session"
                  >
                    <span class="btn-icon">${resolveIcon("camera")}</span>
                    Video
                  </button>
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
            ? html`<${ChatSafeBoundary} label="Chat View"><${ChatView} sessionId=${sessionId} readOnly embedded /><//>`
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
            <${ChatSafeBoundary} label="Agent Toolbar">
              <${ChatInputToolbar} />
            <//>
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
              <${VoiceMicButton}
                disabled=${sending}
                title="Live voice mode"
              />
              ${activeAgentInfo.value?.busy && !stoppingAgent && html`
                <button
                  class="chat-stop-btn"
                  onClick=${handleStop}
                  title="Stop agent"
                  aria-label="Stop agent"
                >⏹</button>
              `}
              <div class="chat-send-group" ref=${sendMenuRef}>
                <button
                  class="chat-send-main"
                  disabled=${!inputValue.trim()}
                  onClick=${activeAgentInfo.value?.busy ? handleSteerWithMessage : handleSend}
                  title=${activeAgentInfo.value?.busy ? "Steer with Message (Enter)" : "Send (Enter)"}
                >➤</button>
                <button
                  class="chat-send-chevron"
                  disabled=${!inputValue.trim()}
                  onClick=${(e) => { e.stopPropagation(); setShowSendMenu(v => !v); }}
                  aria-label="Send options"
                  title="Send options"
                >▾</button>
                ${showSendMenu && html`
                  <div class="chat-send-menu">
                    <button class="chat-send-menu-item" onClick=${handleStopAndSend}>
                      <span class="chat-send-menu-item-icon">⊳</span>
                      <span class="chat-send-menu-item-label">Stop and Send</span>
                    </button>
                    <button class="chat-send-menu-item" onClick=${handleAddToQueue}>
                      <span class="chat-send-menu-item-icon">+</span>
                      <span class="chat-send-menu-item-label">Add to Queue</span>
                      <span class="chat-send-menu-item-kbd">Alt+Enter</span>
                    </button>
                    <button class="chat-send-menu-item active" onClick=${handleSteerWithMessage}>
                      <span class="chat-send-menu-item-icon">→</span>
                      <span class="chat-send-menu-item-label">Steer with Message</span>
                      <span class="chat-send-menu-item-kbd">Enter</span>
                    </button>
                  </div>
                `}
              </div>
            </div>
            <div class="chat-input-hint">
              <span>Shift+Enter for new line</span>
              <span>Type / for commands</span>
              ${offlineQueueSize.peek() > 0 && html`
                <span class="chat-offline-badge">${iconText(`:upload: ${offlineQueueSize.peek()} queued`)}</span>
              `}
              ${queueCount > 0 && html`
                <span class="chat-offline-badge">⏳ ${queueCount} pending</span>
              `}
            </div>
          </div>
        </div>
      </div>
      ${focusMode && html`
        <button 
          class="focus-exit-fab"
          onClick=${() => setFocusMode(false)}
          title="Exit focus mode"
        >${resolveIcon("close")}</button>
      `}
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
