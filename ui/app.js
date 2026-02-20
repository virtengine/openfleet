/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Preact + HTM Entry Point
 *  Modular SPA for Telegram Mini App (no build step)
 * ────────────────────────────────────────────────────────────── */

import { h, render as preactRender } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

// Backend health tracking
const backendDown = signal(false);
const backendError = signal("");
const backendLastSeen = signal(null);
const backendRetryCount = signal(0);
const DESKTOP_MIN_WIDTH = 1200;
const TABLET_MIN_WIDTH = 768;
const COMPACT_NAV_MAX_WIDTH = 520;

/* ── Module imports ── */
import { ICONS } from "./modules/icons.js";
import {
  initTelegramApp,
  onThemeChange,
  getTg,
  isTelegramContext,
  showSettingsButton,
  getTelegramUser,
  colorScheme,
} from "./modules/telegram.js";
import {
  apiFetch,
  connectWebSocket,
  disconnectWebSocket,
  wsConnected,
} from "./modules/api.js";
import {
  connected,
  refreshTab,
  toasts,
  initWsInvalidationListener,
  loadNotificationPrefs,
  applyStoredDefaults,
} from "./modules/state.js";
import { activeTab, navigateTo, TAB_CONFIG } from "./modules/router.js";
import { formatRelative } from "./modules/utils.js";

function getNavHint() {
  if (typeof globalThis === "undefined") return "";
  const isCoarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches;
  if (isCoarse) return "Swipe left/right to switch tabs";
  const isHover = globalThis.matchMedia?.("(hover: hover)")?.matches;
  if (isHover) return "Press 1-8 to switch tabs";
  return "";
}

/* ── Component imports ── */
import { ToastContainer, Modal } from "./components/shared.js";
import { PullToRefresh } from "./components/forms.js";
import {
  SessionList,
  loadSessions,
  createSession,
  selectedSessionId,
  sessionsData,
  initSessionWsListener,
} from "./components/session-list.js";
import { WorkspaceSwitcher, loadWorkspaces } from "./components/workspace-switcher.js";
import { DiffViewer } from "./components/diff-viewer.js";
import {
  CommandPalette,
  useCommandPalette,
} from "./components/command-palette.js";

/* ── Tab imports ── */
import { DashboardTab } from "./tabs/dashboard.js";
import { TasksTab } from "./tabs/tasks.js";
import { ChatTab } from "./tabs/chat.js";
import { AgentsTab } from "./tabs/agents.js";
import { InfraTab } from "./tabs/infra.js";
import { ControlTab } from "./tabs/control.js";
import { LogsTab } from "./tabs/logs.js";
import { SettingsTab } from "./tabs/settings.js";

/* ── Placeholder signals for connection quality (may be provided by api.js) ── */
let wsLatency = signal(null);
let wsReconnectIn = signal(null);
let dataFreshness = signal(null);
try {
  const apiMod = await import("./modules/api.js");
  if (apiMod.wsLatency) wsLatency = apiMod.wsLatency;
  if (apiMod.wsReconnectIn) wsReconnectIn = apiMod.wsReconnectIn;
} catch { /* use placeholder signals */ }
try {
  const stateMod = await import("./modules/state.js");
  if (stateMod.dataFreshness) dataFreshness = stateMod.dataFreshness;
} catch { /* use placeholder signals */ }

/* ── Backend health helpers ── */

function formatTimeAgo(ts) {
  return formatRelative(ts);
}

// Inject offline-banner CSS once
if (typeof document !== "undefined" && !document.getElementById("offline-banner-styles")) {
  const style = document.createElement("style");
  style.id = "offline-banner-styles";
  style.textContent = `
.offline-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin: 8px 16px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 14px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(6px);
  animation: slideDown 0.3s ease-out;
}
.offline-banner-icon { font-size: 20px; }
.offline-banner-content { flex: 1; }
.offline-banner-title { font-weight: 600; font-size: 13px; color: #ef4444; }
.offline-banner-meta { font-size: 12px; opacity: 0.7; margin-top: 2px; }
`;
  document.head.appendChild(style);
}

function useBackendHealth() {
  const intervalRef = useRef(null);

  const checkHealth = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("/api/health", { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      backendDown.value = false;
      backendError.value = "";
      backendLastSeen.value = Date.now();
      backendRetryCount.value = 0;
    } catch (err) {
      backendDown.value = true;
      backendError.value = err?.message || "Connection lost";
      backendRetryCount.value = backendRetryCount.value + 1;
    }
  }, []);

  useEffect(() => {
    checkHealth();
    intervalRef.current = setInterval(checkHealth, 10000);
    return () => clearInterval(intervalRef.current);
  }, [checkHealth]);

  // If WS reconnects, consider backend up
  useEffect(() => {
    if (wsConnected.value && backendDown.value) {
      backendDown.value = false;
      backendError.value = "";
      backendLastSeen.value = Date.now();
      backendRetryCount.value = 0;
    }
  }, [wsConnected.value]);

  return {
    isDown: backendDown.value,
    error: backendError.value,
    lastSeen: backendLastSeen.value,
    retryCount: backendRetryCount.value,
    retry: checkHealth,
  };
}

function OfflineBanner() {
  const { retry: manualRetry } = useBackendHealth();
  return html`
    <div class="offline-banner">
      <div class="offline-banner-icon">⚠️</div>
      <div class="offline-banner-content">
        <div class="offline-banner-title">Backend Unreachable</div>
        <div class="offline-banner-meta">${backendError.value || "Connection lost"}</div>
        ${backendLastSeen.value
          ? html`<div class="offline-banner-meta">Last connected: ${formatTimeAgo(backendLastSeen.value)}</div>`
          : null}
        <div class="offline-banner-meta">Retry attempt #${backendRetryCount.value}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onClick=${manualRetry}>Retry</button>
    </div>
  `;
}

/* ── Tab component map ── */
const TAB_COMPONENTS = {
  dashboard: DashboardTab,
  tasks: TasksTab,
  chat: ChatTab,
  agents: AgentsTab,
  infra: InfraTab,
  control: ControlTab,
  logs: LogsTab,
  settings: SettingsTab,
};

/* ═══════════════════════════════════════════════
 *  Header
 * ═══════════════════════════════════════════════ */
function Header() {
  const isConn = connected.value;
  const wsConn = wsConnected.value;
  const user = getTelegramUser();
  const latency = wsLatency.value;
  const reconnect = wsReconnectIn.value;
  const freshnessRaw = dataFreshness.value;
  const navHint = getNavHint();
  let freshness = null;
  if (typeof freshnessRaw === "number") {
    freshness = Number.isFinite(freshnessRaw) ? freshnessRaw : null;
  } else if (freshnessRaw && typeof freshnessRaw === "object") {
    const vals = Object.values(freshnessRaw).filter((v) => Number.isFinite(v));
    freshness = vals.length ? Math.max(...vals) : null;
  }

  // Connection quality label
  let connLabel = "Offline";
  let connClass = "disconnected";
  if (isConn && latency != null) {
    connLabel = `${latency}ms`;
    connClass = "connected";
  } else if (isConn) {
    connLabel = "Live";
    connClass = "connected";
  } else if (reconnect != null && reconnect > 0) {
    connLabel = `Reconnecting in ${reconnect}s…`;
    connClass = "reconnecting";
  }

  // Freshness label
  let freshnessLabel = "";
  if (freshness != null && Number.isFinite(freshness)) {
    const rel = formatRelative(freshness);
    if (rel && rel !== "—" && !rel.includes("NaN")) {
      freshnessLabel = rel === "just now" ? "Updated just now" : `Updated ${rel}`;
    }
  }

  return html`
    <header class="app-header">
      <div class="app-header-left">
        <div class="app-header-logo">
          <img src="logo.png" alt="Bosun" class="app-logo-img" />
        </div>
        <div class="app-header-titles">
          <div class="app-header-title">Bosun</div>
          <div class="app-header-subtitle">
            ${ICONS[TAB_CONFIG.find((tab) => tab.id === activeTab.value)?.icon] || ""} ${TAB_CONFIG.find((tab) => tab.id === activeTab.value)?.label || "Control Center"}
          </div>
          ${navHint
            ? html`<div class="app-header-hint">${navHint}</div>`
            : null}
        </div>
        <${WorkspaceSwitcher} />
      </div>
      <div class="header-actions">
        <div class="header-status">
          <div class="connection-pill ${connClass}">
            <span class="connection-dot"></span>
            ${connLabel}
          </div>
          ${freshnessLabel
            ? html`<div class="header-freshness">${freshnessLabel}</div>`
            : null}
        </div>
        ${user
          ? html`<div class="app-header-user">@${user.username || user.first_name}</div>`
          : null}
      </div>
    </header>
  `;
}

/* ═══════════════════════════════════════════════
 *  Desktop Sidebar + Session Rail
 * ═══════════════════════════════════════════════ */
function SidebarNav() {
  const user = getTelegramUser();
  const isConn = connected.value;
  return html`
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-logo">
          <img src="logo.png" alt="Bosun" class="app-logo-img" />
        </div>
        <div>
          <div class="sidebar-subtitle">Control Center</div>
        </div>
      </div>
      <div class="sidebar-actions">
        <button class="btn btn-primary btn-block" onClick=${() => createSession({ type: "primary" })}>
          <span class="btn-icon">✨</span> New Session
        </button>
        <button class="btn btn-ghost btn-block" onClick=${() => navigateTo("tasks")}>
          <span class="btn-icon">📋</span> View Tasks
        </button>
      </div>
      <nav class="sidebar-nav">
        ${TAB_CONFIG.map((tab) => {
          const isActive = activeTab.value === tab.id;
          const isHome = tab.id === "dashboard";
          return html`
            <button
              key=${tab.id}
              class="sidebar-nav-item ${isActive ? "active" : ""}"
              aria-label=${tab.label}
              aria-current=${isActive ? "page" : null}
              onClick=${() =>
                navigateTo(tab.id, {
                  resetHistory: isHome,
                  forceRefresh: isHome && isActive,
                })}
            >
              ${ICONS[tab.icon]}
              <span>${tab.label}</span>
            </button>
          `;
        })}
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-status ${isConn ? "online" : "offline"}">
          <span class="sidebar-status-dot"></span>
          ${isConn ? "Connected" : "Offline"}
        </div>
        ${user
          ? html`<div class="sidebar-user">@${user.username || user.first_name || "operator"}</div>`
          : html`<div class="sidebar-user">Operator Console</div>`}
      </div>
    </aside>
  `;
}

function SessionRail({ onResizeStart, onResizeReset, showResizer }) {
  const [showArchived, setShowArchived] = useState(false);
  const sessions = sessionsData.value || [];
  const activeCount = sessions.filter(
    (s) => s.status === "active" || s.status === "running",
  ).length;

  useEffect(() => {
    let mounted = true;
    loadSessions();
    const interval = setInterval(() => {
      if (mounted) loadSessions();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (selectedSessionId.value || sessions.length === 0) return;
    const next =
      sessions.find((s) => s.status === "active" || s.status === "running") ||
      sessions[0];
    if (next?.id) selectedSessionId.value = next.id;
  }, [sessionsData.value, selectedSessionId.value]);

  return html`
    <aside class="session-rail">
      <div class="rail-header">
        <div class="rail-title">Sessions</div>
        <div class="rail-meta">
          ${activeCount} active · ${sessions.length} total
        </div>
      </div>
      <${SessionList}
        showArchived=${showArchived}
        onToggleArchived=${setShowArchived}
        defaultType="primary"
      />
      ${showResizer
        ? html`
            <div
              class="rail-resizer"
              role="separator"
              aria-label="Resize sessions panel"
              onPointerDown=${(e) => onResizeStart("rail", e)}
              onDoubleClick=${() => onResizeReset("rail")}
            ></div>
          `
        : null}
    </aside>
  `;
}

function InspectorPanel({ onResizeStart, onResizeReset, showResizer }) {
  const sessionId = selectedSessionId.value;
  const session = (sessionsData.value || []).find((s) => s.id === sessionId);
  const isSessionTab = activeTab.value === "chat" || activeTab.value === "agents";
  const status = session?.status || "idle";
  const type = session?.type || "manual";
  const lastActive = session?.updatedAt || session?.createdAt;
  const preview = session?.lastMessage
    ? session.lastMessage.slice(0, 160)
    : "No messages yet.";
  const [smartLogs, setSmartLogs] = useState([]);
  const [logState, setLogState] = useState("idle");

  useEffect(() => {
    if (!isSessionTab) return;
    let active = true;
    const fetchLogs = async () => {
      try {
        setLogState("loading");
        const res = await apiFetch("/api/logs?lines=120", { _silent: true });
        if (!active) return;
        const lines = res?.data?.lines || res?.lines || [];
        const allLines = Array.isArray(lines) ? lines : [];
        const tokens = [sessionId, session?.taskId, session?.branch]
          .filter(Boolean)
          .map((t) => String(t).toLowerCase());
        const classified = allLines.map((line) => {
          const lower = String(line || "").toLowerCase();
          let level = "info";
          if (
            lower.includes("fatal") ||
            lower.includes("panic") ||
            lower.includes("exception") ||
            lower.includes("unauthorized") ||
            lower.includes("denied") ||
            lower.includes("error")
          ) {
            level = "error";
          } else if (lower.includes("warn")) {
            level = "warn";
          } else if (lower.includes("timeout")) {
            level = "warn";
          }
          return { line: String(line || ""), level, lower };
        });
        const sessionHits = tokens.length
          ? classified.filter((entry) =>
              tokens.some((token) => entry.lower.includes(token)),
            )
          : [];
        const severityHits = classified.filter((entry) => entry.level !== "info");
        let selected = sessionHits.length ? sessionHits : severityHits;
        if (!selected.length && (status === "active" || status === "running")) {
          selected = classified.slice(-3);
        }
        const pruned = selected.slice(-6).map((entry) => ({
          line: entry.line,
          level: entry.level,
        }));
        setSmartLogs(pruned);
        setLogState("ready");
      } catch {
        if (active) setLogState("error");
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 12000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isSessionTab, sessionId, session?.taskId, session?.branch, status]);

  return html`
    <aside class="inspector">
      <div class="inspector-section">
        <div class="inspector-title">Focus</div>
        ${session
          ? html`
              <div class="inspector-kv"><span>Session</span><strong>${session.title || session.taskId || session.id}</strong></div>
              <div class="inspector-kv"><span>Status</span><strong>${status}</strong></div>
              <div class="inspector-kv"><span>Type</span><strong>${type}</strong></div>
              <div class="inspector-kv"><span>Last Active</span><strong>${lastActive ? formatRelative(lastActive) : "—"}</strong></div>
              <div class="inspector-kv"><span>Preview</span><strong>${preview}</strong></div>
            `
          : html`<div class="inspector-empty">Select a session to see context.</div>`}
      </div>

      ${isSessionTab
        ? html`
            <div class="inspector-section inspector-scroll">
              <div class="inspector-title">Latest Diff</div>
              <${DiffViewer} sessionId=${sessionId} />
            </div>
            <div class="inspector-section">
              <div class="inspector-title">Smart Logs</div>
              ${logState === "error"
                ? html`<div class="inspector-empty">Log stream unavailable.</div>`
                : smartLogs.length === 0
                  ? html`<div class="inspector-empty">No noteworthy logs right now.</div>`
                  : html`
                      <div class="inspector-scroll">
                        ${smartLogs.map(
                          (entry, idx) => html`
                            <div key=${idx} class="inspector-log-line ${entry.level}">
                              ${entry.line.length > 220 ? entry.line.slice(-220) : entry.line}
                            </div>
                          `,
                        )}
                      </div>
                    `}
              <button class="btn btn-ghost btn-sm" onClick=${() => navigateTo("logs")}>
                Open Logs
              </button>
            </div>
          `
        : html`
            <div class="inspector-section">
              <div class="inspector-title">System Pulse</div>
              <div class="inspector-kv"><span>API</span><strong>${connected.value ? "Connected" : "Offline"}</strong></div>
              <div class="inspector-kv"><span>WebSocket</span><strong>${wsConnected.value ? "Live" : "Closed"}</strong></div>
              <div class="inspector-kv"><span>Last Seen</span><strong>${backendLastSeen.value ? formatRelative(backendLastSeen.value) : "—"}</strong></div>
            </div>
          `}
      ${showResizer
        ? html`
            <div
              class="inspector-resizer"
              role="separator"
              aria-label="Resize inspector panel"
              onPointerDown=${(e) => onResizeStart("inspector", e)}
              onDoubleClick=${() => onResizeReset("inspector")}
            ></div>
          `
        : null}
    </aside>
  `;
}

/* ═══════════════════════════════════════════════
 *  Bottom Navigation
 * ═══════════════════════════════════════════════ */
const PRIMARY_NAV_TABS = ["dashboard", "chat", "tasks", "agents"];
const MORE_NAV_TABS = ["control", "infra", "logs", "settings"];

function getTabsById(ids) {
  return ids
    .map((id) => TAB_CONFIG.find((tab) => tab.id === id))
    .filter(Boolean);
}

function BottomNav({ compact, moreOpen, onToggleMore, onNavigate }) {
  const primaryTabs = getTabsById(PRIMARY_NAV_TABS);
  return html`
    <nav class=${`bottom-nav ${compact ? "compact" : ""}`}>
      ${primaryTabs.map((tab) => {
        const isHome = tab.id === "dashboard";
        const isActive = activeTab.value === tab.id;
        return html`
          <button
            key=${tab.id}
            class="nav-item ${isActive ? "active" : ""}"
            aria-label=${`Go to ${tab.label}`}
            onClick=${() =>
              onNavigate(tab.id, {
                resetHistory: isHome,
                forceRefresh: isHome && isActive,
              })}
          >
            ${ICONS[tab.icon]}
            <span class="nav-label">${tab.label}</span>
          </button>
        `;
      })}
      <button
        class="nav-item nav-item-more ${moreOpen ? "active" : ""}"
        aria-haspopup="dialog"
        aria-expanded=${moreOpen ? "true" : "false"}
        aria-label=${moreOpen ? "Close more menu" : "Open more menu"}
        onClick=${onToggleMore}
      >
        ${ICONS.ellipsis}
        <span class="nav-label">More</span>
      </button>
    </nav>
  `;
}

function MoreSheet({ open, onClose, onNavigate }) {
  const primaryTabs = getTabsById(PRIMARY_NAV_TABS);
  const moreTabs = getTabsById(MORE_NAV_TABS);
  return html`
    <${Modal} title="More" open=${open} onClose=${onClose}>
      <div class="more-menu" role="navigation" aria-label="More menu">
        <div class="more-menu-section">
          <div class="more-menu-section-title">Quick Access</div>
          <div class="more-menu-grid">
            ${primaryTabs.map((tab) => {
              const isHome = tab.id === "dashboard";
              const isActive = activeTab.value === tab.id;
              return html`
                <button
                  key=${tab.id}
                  class="more-menu-item ${isActive ? "active" : ""}"
                  aria-label=${`Open ${tab.label}`}
                  onClick=${() =>
                    onNavigate(tab.id, {
                      resetHistory: isHome,
                    })}
                >
                  <span class="more-menu-icon">${ICONS[tab.icon]}</span>
                  <span class="more-menu-label">${tab.label}</span>
                </button>
              `;
            })}
          </div>
        </div>
        <div class="more-menu-section">
          <div class="more-menu-section-title">Explore</div>
          <div class="more-menu-grid">
            ${moreTabs.map((tab) => {
              const isHome = tab.id === "dashboard";
              const isActive = activeTab.value === tab.id;
              return html`
                <button
                  key=${tab.id}
                  class="more-menu-item ${isActive ? "active" : ""}"
                  aria-label=${`Open ${tab.label}`}
                  onClick=${() =>
                    onNavigate(tab.id, {
                      resetHistory: isHome,
                    })}
                >
                  <span class="more-menu-icon">${ICONS[tab.icon]}</span>
                  <span class="more-menu-label">${tab.label}</span>
                </button>
              `;
            })}
          </div>
        </div>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  App Root
 * ═══════════════════════════════════════════════ */
function App() {
  useBackendHealth();
  const { open: paletteOpen, onClose: paletteClose } = useCommandPalette();
  const mainRef = useRef(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollVisibilityRef = useRef(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const resizeRef = useRef(null);
  const [isCompactNav, setIsCompactNav] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(`(max-width: ${COMPACT_NAV_MAX_WIDTH}px)`).matches;
  });
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`).matches;
  });
  const [isTablet, setIsTablet] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    const w = window.innerWidth;
    return w >= TABLET_MIN_WIDTH && w < DESKTOP_MIN_WIDTH;
  });
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(() => {
    if (typeof window === "undefined") return 320;
    const stored = Number(localStorage.getItem("ve-rail-width"));
    return Number.isFinite(stored) ? stored : 320;
  });
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (typeof window === "undefined") return 320;
    const stored = Number(localStorage.getItem("ve-inspector-width"));
    return Number.isFinite(stored) ? stored : 320;
  });

  const clamp = useCallback((value, min, max) => {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }, []);

  const handleResizeMove = useCallback((event) => {
    const state = resizeRef.current;
    if (!state) return;
    const delta = event.clientX - state.startX;
    if (state.type === "rail") {
      const next = clamp(state.startRail + delta, 240, 440);
      setRailWidth(next);
    } else {
      const next = clamp(state.startInspector - delta, 260, 440);
      setInspectorWidth(next);
    }
  }, [clamp]);

  const handleResizeEnd = useCallback(() => {
    resizeRef.current = null;
    document.body.classList.remove("is-resizing");
    window.removeEventListener("pointermove", handleResizeMove);
    window.removeEventListener("pointerup", handleResizeEnd);
  }, [handleResizeMove]);

  const handleResizeStart = useCallback(
    (type, event) => {
      if (!isDesktop) return;
      event.preventDefault();
      event.stopPropagation();
      resizeRef.current = {
        type,
        startX: event.clientX,
        startRail: railWidth,
        startInspector: inspectorWidth,
      };
      document.body.classList.add("is-resizing");
      window.addEventListener("pointermove", handleResizeMove);
      window.addEventListener("pointerup", handleResizeEnd);
    },
    [isDesktop, railWidth, inspectorWidth, handleResizeMove, handleResizeEnd],
  );

  const handleResizeReset = useCallback((type) => {
    if (type === "rail") setRailWidth(320);
    if (type === "inspector") setInspectorWidth(320);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const update = () => setIsDesktop(query.matches);
    update();
    if (query.addEventListener) query.addEventListener("change", update);
    else query.addListener(update);
    return () => {
      if (query.removeEventListener) query.removeEventListener("change", update);
      else query.removeListener(update);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const tabletQuery = window.matchMedia(
      `(min-width: ${TABLET_MIN_WIDTH}px) and (max-width: ${DESKTOP_MIN_WIDTH - 1}px)`,
    );
    const update = () => setIsTablet(tabletQuery.matches);
    update();
    if (tabletQuery.addEventListener) tabletQuery.addEventListener("change", update);
    else tabletQuery.addListener(update);
    return () => {
      if (tabletQuery.removeEventListener) tabletQuery.removeEventListener("change", update);
      else tabletQuery.removeListener(update);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(`(max-width: ${COMPACT_NAV_MAX_WIDTH}px)`);
    const update = () => setIsCompactNav(query.matches);
    update();
    if (query.addEventListener) query.addEventListener("change", update);
    else query.addListener(update);
    return () => {
      if (query.removeEventListener) query.removeEventListener("change", update);
      else query.removeListener(update);
    };
  }, []);

  useEffect(() => {
    if (!isDesktop || typeof window === "undefined") return;
    localStorage.setItem("ve-rail-width", String(railWidth));
  }, [railWidth, isDesktop]);

  useEffect(() => {
    if (!isDesktop || typeof window === "undefined") return;
    localStorage.setItem("ve-inspector-width", String(inspectorWidth));
  }, [inspectorWidth, isDesktop]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (isDesktop) {
      document.documentElement.dataset.desktop = "true";
      delete document.documentElement.dataset.tablet;
      // Close drawers when switching to desktop — panels are always visible
      setSidebarDrawerOpen(false);
      setInspectorDrawerOpen(false);
    } else if (isTablet) {
      delete document.documentElement.dataset.desktop;
      document.documentElement.dataset.tablet = "true";
    } else {
      delete document.documentElement.dataset.desktop;
      delete document.documentElement.dataset.tablet;
      setSidebarDrawerOpen(false);
      setInspectorDrawerOpen(false);
    }
  }, [isDesktop, isTablet]);

  const closeMore = useCallback(() => setIsMoreOpen(false), []);

  const handleNavigate = useCallback((tabId, options = {}) => {
    setIsMoreOpen(false);
    navigateTo(tabId, options);
  }, []);

  const toggleMore = useCallback(() => {
    setIsMoreOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (typeof globalThis === "undefined") return;
    const handler = () => setIsMoreOpen(false);
    globalThis.addEventListener("ve:close-modals", handler);
    return () => globalThis.removeEventListener("ve:close-modals", handler);
  }, []);

  useEffect(() => {
    setIsMoreOpen(false);
    setSidebarDrawerOpen(false);
    setInspectorDrawerOpen(false);
  }, [activeTab.value]);

  useEffect(() => {
    // Initialize Telegram Mini App SDK
    initTelegramApp();

    // Theme change monitoring
    const unsub = onThemeChange(() => {
      colorScheme.value = getTg()?.colorScheme || "dark";
    });

    // Show settings button in Telegram header
    showSettingsButton(() => navigateTo("settings"));

    // Connect WebSocket + invalidation auto-refresh
    connectWebSocket();
    initWsInvalidationListener();
    initSessionWsListener();

    // Load notification preferences early (non-blocking)
    loadNotificationPrefs();

    // Load initial data for the default tab, then apply stored executor defaults
    refreshTab("dashboard").then(() => applyStoredDefaults());

    // Global keyboard shortcuts (1-7 for tabs, Escape for modals)
    function handleGlobalKeys(e) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (document.activeElement?.isContentEditable) return;

      // Number keys 1-8 to switch tabs
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 8 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tabCfg = TAB_CONFIG[num - 1];
        if (tabCfg) {
          e.preventDefault();
          navigateTo(tabCfg.id);
        }
        return;
      }

      // Escape to close modals/palette
      if (e.key === "Escape") {
        globalThis.dispatchEvent(new CustomEvent("ve:close-modals"));
      }
    }
    document.addEventListener("keydown", handleGlobalKeys);

    return () => {
      unsub();
      disconnectWebSocket();
      document.removeEventListener("keydown", handleGlobalKeys);
    };
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const handleScroll = () => {
      const shouldShow = el.scrollTop > 280;
      if (shouldShow !== scrollVisibilityRef.current) {
        scrollVisibilityRef.current = shouldShow;
        setShowScrollTop(shouldShow);
      }
    };
    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const swipeTabs = TAB_CONFIG.filter((t) => t.id !== "settings");
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;
    let blocked = false;

    const shouldBlockSwipe = (target) => {
      if (!target || typeof target.closest !== "function") return false;
      return Boolean(
        target.closest(".kanban-board") ||
        target.closest(".kanban-cards") ||
        target.closest(".chat-messages"),
      );
    };

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const target = e.target;
      blocked = shouldBlockSwipe(target);
      if (blocked) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
    };

    const onTouchMove = (e) => {
      if (!tracking || blocked) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
      }
    };

    const onTouchEnd = (e) => {
      if (!tracking || blocked) return;
      tracking = false;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const dt = Date.now() - startTime;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) || dt > 700) return;

      const currentIndex = swipeTabs.findIndex(
        (tab) => tab.id === activeTab.value,
      );
      if (currentIndex < 0) return;
      const direction = dx < 0 ? 1 : -1;
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= swipeTabs.length) return;
      navigateTo(swipeTabs[nextIndex].id);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const CurrentTab = TAB_COMPONENTS[activeTab.value] || DashboardTab;
  const isChatOrAgents = activeTab.value === "chat" || activeTab.value === "agents";
  const showSessionRail = isDesktop && isChatOrAgents;
  const showInspector = isDesktop && isChatOrAgents;

  // On tablet: show toggle buttons for sidebar + inspector when relevant
  const showDrawerToggles = isTablet;
  const showInspectorToggle = isTablet && isChatOrAgents;

  const shellStyle = isDesktop
    ? {
        "--rail-width": `${railWidth}px`,
        "--inspector-width": `${inspectorWidth}px`,
      }
    : null;

  const toggleSidebar = useCallback(() => {
    setSidebarDrawerOpen((v) => !v);
    setInspectorDrawerOpen(false);
  }, []);

  const toggleInspector = useCallback(() => {
    setInspectorDrawerOpen((v) => !v);
    setSidebarDrawerOpen(false);
  }, []);

  const closeDrawers = useCallback(() => {
    setSidebarDrawerOpen(false);
    setInspectorDrawerOpen(false);
  }, []);

  return html`
    <div
      class="app-shell"
      style=${shellStyle}
      data-tab=${activeTab.value}
      data-has-rail=${showSessionRail ? "true" : "false"}
      data-has-inspector=${showInspector ? "true" : "false"}
    >
      <${SidebarNav} />

      ${/* Sidebar drawer overlay for tablet */ ""}
      ${sidebarDrawerOpen && !isDesktop
        ? html`
            <div class="drawer-overlay" onClick=${closeDrawers}></div>
            <div class="drawer drawer-left">
              <${SidebarNav} />
            </div>
          `
        : null}

      ${/* Inspector drawer overlay for tablet */ ""}
      ${inspectorDrawerOpen && !isDesktop
        ? html`
            <div class="drawer-overlay" onClick=${closeDrawers}></div>
            <div class="drawer drawer-right">
              <${InspectorPanel}
                onResizeStart=${handleResizeStart}
                onResizeReset=${handleResizeReset}
                showResizer=${false}
              />
            </div>
          `
        : null}

      ${showSessionRail
        ? html`<${SessionRail}
            onResizeStart=${handleResizeStart}
            onResizeReset=${handleResizeReset}
            showResizer=${isDesktop}
          />`
        : null}
      <div class="app-main">
        <div class="main-panel">
          <${Header} />

          ${/* Tablet action bar with drawer toggles */ ""}
          ${showDrawerToggles
            ? html`
                <div class="tablet-action-bar">
                  <button
                    class="btn btn-ghost btn-sm tablet-toggle"
                    onClick=${toggleSidebar}
                    aria-label=${sidebarDrawerOpen ? "Close sidebar" : "Open sidebar"}
                  >
                    ☰ Navigation
                  </button>
                  ${showInspectorToggle
                    ? html`
                        <button
                          class="btn btn-ghost btn-sm tablet-toggle"
                          onClick=${toggleInspector}
                          aria-label=${inspectorDrawerOpen ? "Close inspector" : "Open inspector"}
                        >
                          📋 Inspector
                        </button>
                      `
                    : null}
                </div>
              `
            : null}

          ${backendDown.value ? html`<${OfflineBanner} />` : null}
          <${ToastContainer} />
          <${CommandPalette} open=${paletteOpen} onClose=${paletteClose} />
          <${PullToRefresh} onRefresh=${() => refreshTab(activeTab.value)}>
            <main class="main-content" ref=${mainRef}>
              <${CurrentTab} />
            </main>
          <//>
          ${showScrollTop &&
          html`
            <button
              class="scroll-top"
              title="Back to top"
              onClick=${() => {
                mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              Top
            </button>
          `}
        </div>
      </div>
      ${showInspector
        ? html`<${InspectorPanel}
            onResizeStart=${handleResizeStart}
            onResizeReset=${handleResizeReset}
            showResizer=${isDesktop}
          />`
        : null}
    </div>
    <${BottomNav}
      compact=${isCompactNav}
      moreOpen=${isMoreOpen}
      onToggleMore=${toggleMore}
      onNavigate=${handleNavigate}
    />
    <${MoreSheet}
      open=${isMoreOpen}
      onClose=${closeMore}
      onNavigate=${handleNavigate}
    />
  `;
}

/* ─── Mount ─── */
preactRender(html`<${App} />`, document.getElementById("app"));
