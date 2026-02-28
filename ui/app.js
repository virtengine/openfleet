/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Preact + HTM Entry Point
 *  Modular SPA for Telegram Mini App (no build step)
 * ────────────────────────────────────────────────────────────── */

// ── Error telemetry ring buffer (max 50 entries, persisted to sessionStorage) ──
const MAX_ERROR_LOG = 50;
function getErrorLog() {
  try { return JSON.parse(sessionStorage.getItem("ve_error_log") || "[]"); } catch { return []; }
}
function appendErrorLog(entry) {
  try {
    const log = getErrorLog();
    log.unshift({ ...entry, ts: Date.now() });
    if (log.length > MAX_ERROR_LOG) log.length = MAX_ERROR_LOG;
    sessionStorage.setItem("ve_error_log", JSON.stringify(log));
  } catch { /* quota exceeded */ }
}

function maybeRemountUi(message) {
  if (!/insertBefore/i.test(message || "")) return;
  const remount = globalThis.__veRemountApp;
  if (typeof remount === "function") {
    console.warn("[ve] attempting UI remount after render error");
    remount();
  }
}

/* ── Global error handlers — catch unhandled errors before they freeze the UI ── */
globalThis.addEventListener?.("error", (e) => {
  console.error("[ve:global-error]", e.error || e.message);
  appendErrorLog({ type: "global", message: e.message, stack: e.error?.stack });
  maybeRemountUi(e?.message || e?.error?.message || "");
});
globalThis.addEventListener?.("unhandledrejection", (e) => {
  const reason = e?.reason;
  const message = String(reason?.message || reason || "");
  if (/WebAppMethodUnsupported/i.test(message)) {
    e.preventDefault?.();
    return;
  }
  console.error("[ve:unhandled-rejection]", e.reason);
  appendErrorLog({ type: "rejection", message: String(e.reason?.message || e.reason) });
  maybeRemountUi(message);
});

import { h, render as preactRender, Component } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

// Backend health tracking
const backendDown = signal(false);
const backendError = signal("");
const backendLastSeen = signal(null);
const backendRetryCount = signal(0);
const DESKTOP_MIN_WIDTH = 1400;
const TABLET_MIN_WIDTH = 768;
const COMPACT_NAV_MAX_WIDTH = 520;
const RAIL_ICON_WIDTH = 54;
const SIDEBAR_ICON_WIDTH = 54;
const APP_LOGO_SOURCES = ["/logo.png", "/logo.svg", "/favicon.png"];
const VOICE_LAUNCH_QUERY_KEYS = [
  "launch",
  "call",
  "autostart",
  "sessionId",
  "executor",
  "mode",
  "model",
  "vision",
  "source",
  "chat_id",
];
const FLOATING_CALL_STATE_KEY = "ve-floating-call-state";

function getAppLogoSource(index = 0) {
  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  if (safeIndex <= 0) return APP_LOGO_SOURCES[0];
  if (safeIndex >= APP_LOGO_SOURCES.length) {
    return APP_LOGO_SOURCES[APP_LOGO_SOURCES.length - 1];
  }
  return APP_LOGO_SOURCES[safeIndex];
}

function handleAppLogoLoadError(event) {
  const target = event?.currentTarget;
  if (!target) return;

  const currentIndex = Number.parseInt(
    String(target.dataset?.logoFallbackIndex || "0"),
    10,
  );
  const nextIndex = Number.isFinite(currentIndex) ? currentIndex + 1 : 1;
  if (nextIndex >= APP_LOGO_SOURCES.length) return;

  target.dataset.logoFallbackIndex = String(nextIndex);
  target.src = getAppLogoSource(nextIndex);
}

function parseVoiceLaunchFromUrl() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search || "");
  const launch = String(params.get("launch") || "").trim().toLowerCase();
  if (launch !== "meeting" && launch !== "voice") return null;

  const callRaw = String(params.get("call") || "").trim().toLowerCase();
  const call = callRaw === "video" ? "video" : "voice";
  const explicitVision = String(params.get("vision") || "").trim().toLowerCase();
  const initialVisionSource =
    explicitVision === "camera" || explicitVision === "screen"
      ? explicitVision
      : call === "video"
        ? "camera"
        : null;

  return {
    tab: "chat",
    detail: {
      call,
      initialVisionSource,
      sessionId: String(params.get("sessionId") || "").trim() || null,
      executor: String(params.get("executor") || "").trim() || null,
      mode: String(params.get("mode") || "").trim() || null,
      model: String(params.get("model") || "").trim() || null,
    },
  };
}

function scrubVoiceLaunchQuery() {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of VOICE_LAUNCH_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", nextPath || "/");
}

function isFollowWindowFromUrl() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search || "");
  return params.get("follow") === "1";
}

function readFloatingCallState() {
  if (typeof window === "undefined") return { active: false };
  try {
    const raw = localStorage.getItem(FLOATING_CALL_STATE_KEY);
    if (!raw) return { active: false };
    const parsed = JSON.parse(raw);
    return {
      active: parsed?.active === true,
      call: String(parsed?.call || "").trim().toLowerCase() === "video"
        ? "video"
        : "voice",
      updatedAt: Number(parsed?.updatedAt || 0) || Date.now(),
    };
  } catch {
    return { active: false };
  }
}

function writeFloatingCallState(nextState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      FLOATING_CALL_STATE_KEY,
      JSON.stringify({
        active: nextState?.active === true,
        call:
          String(nextState?.call || "").trim().toLowerCase() === "video"
            ? "video"
            : "voice",
        updatedAt: Date.now(),
      }),
    );
  } catch {
    // best effort
  }
}

/* ── Module imports ── */
import { ICONS } from "./modules/icons.js";
import { iconText, resolveIcon } from "./modules/icon-utils.js";
import {
  initTelegramApp,
  onThemeChange,
  getTg,
  showSettingsButton,
  getTelegramUser,
  colorScheme,
} from "./modules/telegram.js";
import {
  apiFetch,
  connectWebSocket,
  disconnectWebSocket,
  wsConnected,
  loadingCount,
} from "./modules/api.js";
import {
  connected,
  statusData,
  executorData,
  tasksData,
  agentsData,
  refreshTab,
  initWsInvalidationListener,
  loadNotificationPrefs,
  applyStoredDefaults,
  hasPendingChanges,
} from "./modules/state.js";
import {
  activeTab,
  navigateTo,
  shouldBlockTabSwipe,
  TAB_CONFIG,
} from "./modules/router.js";
import { formatRelative } from "./modules/utils.js";

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
import {
  activeAgent,
  agentMode,
  selectedModel,
} from "./components/agent-selector.js";
import { WorkspaceSwitcher } from "./components/workspace-switcher.js";
import { DiffViewer } from "./components/diff-viewer.js";
import {
  CommandPalette,
  useCommandPalette,
} from "./components/command-palette.js";
import { VoiceOverlay } from "./modules/voice-overlay.js";

/* ── Tab imports ── */
import { DashboardTab } from "./tabs/dashboard.js";
import { TasksTab } from "./tabs/tasks.js";
import { ChatTab } from "./tabs/chat.js";
import { AgentsTab, FleetSessionsTab } from "./tabs/agents.js";
import { InfraTab } from "./tabs/infra.js";
import { ControlTab } from "./tabs/control.js";
import { LogsTab } from "./tabs/logs.js";
import { TelemetryTab } from "./tabs/telemetry.js";
import { SettingsTab } from "./tabs/settings.js";
import { WorkflowsTab } from "./tabs/workflows.js";
import { LibraryTab } from "./tabs/library.js";

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

/* ── Shared components ── */

/**
 * AnimatedNumber — smoothly counts from previous to new value using rAF.
 */
function AnimatedNumber({ value, duration = 600, className = "" }) {
  const displayRef = useRef(value);
  const rafRef = useRef(null);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const from = displayRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const animate = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease out cubic
      const current = Math.round(from + (to - from) * eased);
      displayRef.current = current;
      setDisplay(current);
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return html`<span class="${className}">${display}</span>`;
}

/**
 * KeyboardShortcutsModal — shows available keyboard shortcuts.
 */
function KeyboardShortcutsModal({ onClose }) {
  const shortcuts = [
    { key: "1–8", desc: "Switch tabs" },
    { key: "c",   desc: "Create task (on Dashboard)" },
    { key: "?",   desc: "Show keyboard shortcuts" },
    { key: "Esc", desc: "Close modal / palette" },
  ];
  return html`
    <${Modal} title="Keyboard Shortcuts" onClose=${onClose}>
      <div class="shortcuts-list">
        ${shortcuts.map((s) => html`
          <div class="shortcut-item" key=${s.key}>
            <kbd class="shortcut-key">${s.key}</kbd>
            <span class="shortcut-desc">${s.desc}</span>
          </div>
        `)}
      </div>
    <//>  
  `;
}

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
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 14px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(6px);
  animation: slideDown 0.3s ease-out;
  transition: background 0.4s ease, border-color 0.4s ease;
}
.offline-banner.tone-orange {
  background: rgba(249, 115, 22, 0.08);
  border-color: rgba(249, 115, 22, 0.25);
}
.offline-banner.tone-red {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.3);
}
.offline-banner-icon { font-size: 20px; }
.offline-banner-content { flex: 1; }
.offline-banner-title { font-weight: 600; font-size: 13px; }
.tone-orange .offline-banner-title { color: #f97316; }
.tone-red .offline-banner-title    { color: #ef4444; }
.offline-banner-meta { font-size: 12px; opacity: 0.7; margin-top: 2px; }
.offline-reconnect-bar {
  height: 2px; border-radius: 2px; margin-top: 6px;
  background: rgba(249,115,22,0.18);
  overflow: hidden;
}
.offline-reconnect-fill {
  height: 100%; border-radius: 2px;
  background: #f97316;
  transition: width 1s linear;
}
.tone-red .offline-reconnect-fill { background: #ef4444; }
.offline-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  animation: offlinePulse 1.6s ease-in-out infinite;
}
.offline-dot.orange { background: #f97316; }
.offline-dot.red    { background: #ef4444; }
@keyframes offlinePulse {
  0%,100% { opacity:1; transform:scale(1); }
  50%     { opacity:0.5; transform:scale(1.3); }
}
`;
  document.head.appendChild(style);
}

function useBackendHealth() {
  const intervalRef = useRef(null);

  const checkHealth = useCallback(async () => {
    try {
      // Use apiFetch (includes Telegram initData auth header) instead of raw fetch
      const res = await apiFetch("/api/health", { _silent: true });
      if (!res?.ok) throw new Error(res?.error || "Health check failed");
      backendDown.value = false;
      backendError.value = "";
      backendLastSeen.value = Date.now();
      backendRetryCount.value = 0;
    } catch (err) {
      // Only mark as down if WS is also disconnected — WS is the primary
      // connectivity signal; the health check is a fallback.
      if (!wsConnected.value) {
        backendDown.value = true;
        backendError.value = err?.message || "Connection lost";
        backendRetryCount.value = backendRetryCount.value + 1;
      }
    }
  }, []);

  useEffect(() => {
    checkHealth();
    intervalRef.current = setInterval(checkHealth, 15000);
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
  // Don't call useBackendHealth() here — the App component already runs it.
  // Calling it here caused a mount/unmount oscillation: App health check fails
  // (no auth) → backendDown=true → OfflineBanner mounts → effect corrects it
  // → backendDown=false → unmount → repeat every 10s.
  const manualRetry = useCallback(async () => {
    try {
      const res = await apiFetch("/api/health", { _silent: true });
      if (res?.ok) {
        backendDown.value = false;
        backendError.value = "";
        backendLastSeen.value = Date.now();
        backendRetryCount.value = 0;
      }
    } catch { /* handled by signal */ }
  }, []);

  const retryCount = backendRetryCount.value;
  const isPersistent = retryCount > 3;
  const tone = isPersistent ? "red" : "orange";
  const title = isPersistent
    ? "Persistent connection failure"
    : "Backend Unreachable";

  // Reconnect countdown drives the progress bar
  const countdown = wsReconnectIn.value;
  const maxWait = 15; // max backoff seconds
  const reconnectPct = countdown != null && countdown > 0
    ? Math.round(((maxWait - Math.min(countdown, maxWait)) / maxWait) * 100)
    : 100;

  return html`
    <div class="offline-banner tone-${tone}">
      <div class="offline-dot ${tone}"></div>
      <div class="offline-banner-content">
        <div class="offline-banner-title">${title}</div>
        <div class="offline-banner-meta">${backendError.value || "Connection lost"}</div>
        ${backendLastSeen.value
          ? html`<div class="offline-banner-meta">Last connected: ${formatTimeAgo(backendLastSeen.value)}</div>`
          : null}
        <div class="offline-banner-meta">
          ${countdown != null && countdown > 0
            ? `Reconnecting in ${countdown}s…`
            : `Retry attempt #${retryCount}`}
        </div>
        <div class="offline-reconnect-bar">
          <div class="offline-reconnect-fill" style="width:${reconnectPct}%"></div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" onClick=${manualRetry}>Retry</button>
    </div>
  `;
}

/* ── Error Boundary — catches render errors in child components ── */
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, showStack: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[TabErrorBoundary] Caught error:", error, info);
    appendErrorLog({ type: "render", tab: this.props.tabName, message: error?.message, stack: error?.stack });
  }
  render() {
    if (this.state.error) {
      const retry = () => this.setState({ error: null, showStack: false });
      const err = this.state.error;
      const tabName = this.props.tabName || "";
      const errorMsg = err?.message || "An unexpected error occurred while rendering this tab.";
      const stack = err?.stack || "";
      const stackToggleLabel = this.state.showStack ? "Hide Stack" : "Stack Trace";
      const copyError = () => {
        const text = `${errorMsg}\n\n${stack}`;
        navigator?.clipboard?.writeText(text).catch(() => {});
      };
      const toggleStack = () => this.setState((s) => ({ showStack: !s.showStack }));
      return html`
        <div class="tab-error-boundary">
          <div class="tab-error-pulse">
            <span style="font-size:20px;color:#ef4444;">${resolveIcon(":alert:")}</span>
          </div>
          <div>
            <div style="font-size:14px;font-weight:600;margin-bottom:4px;color:var(--text-primary);">
              Something went wrong${tabName ? ` in ${tabName}` : ""}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);max-width:400px;">
              ${errorMsg}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
            <button class="btn btn-primary btn-sm" onClick=${retry}>Retry</button>
            <button class="btn btn-ghost btn-sm" onClick=${copyError}>Copy Error</button>
            ${stack ? html`<button class="btn btn-ghost btn-sm" onClick=${toggleStack}>
              ${stackToggleLabel}
            </button>` : null}
            <button class="btn btn-ghost btn-sm" onClick=${() => {
              console.group("[ve:error-log]");
              getErrorLog().forEach((e, i) => console.log(i, e));
              console.groupEnd();
            }}>Error Log</button>
          </div>
          ${this.state.showStack && stack ? html`
            <div class="tab-error-stack">${stack}</div>
          ` : null}
        </div>
      `;
    }
    return html`<div class="tab-content-enter">${this.props.children}</div>`;
  }
}

/* ── Tab component map ── */
const TAB_COMPONENTS = {
  dashboard: DashboardTab,
  tasks: TasksTab,
  chat: ChatTab,
  agents: AgentsTab,
  "fleet-sessions": FleetSessionsTab,
  infra: InfraTab,
  control: ControlTab,
  logs: LogsTab,
  telemetry: TelemetryTab,
  workflows: WorkflowsTab,
  library: LibraryTab,
  settings: SettingsTab,
};

/* ═══════════════════════════════════════════════
 *  Header
 * ═══════════════════════════════════════════════ */
function Header() {
  const isConn = connected.value;
  const user = getTelegramUser();
  const latency = wsLatency.value;
  const reconnect = wsReconnectIn.value;
  const freshnessRaw = dataFreshness.value;
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
        <div class="app-header-workspace">
          <${WorkspaceSwitcher} />
        </div>
      </div>
      <div class="app-header-right">
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
      </div>
    </header>
  `;
}

/* ═══════════════════════════════════════════════
 *  Desktop Sidebar + Session Rail
 * ═══════════════════════════════════════════════ */
function SidebarNav({ collapsed = false, onToggle }) {
  const user = getTelegramUser();
  const isConn = connected.value;

  const collapseIcon = collapsed
    ? html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3l5 5-5 5"/></svg>`
    : html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 3l-5 5 5 5"/></svg>`;

  return html`
    <aside class="sidebar ${collapsed ? 'sidebar-icon-only' : ''}">
      <div class="sidebar-brand-row">
        <div class="sidebar-brand">
          <div class="sidebar-logo">
            <img
              src=${getAppLogoSource(0)}
              alt="Bosun"
              class="app-logo-img"
              data-logo-fallback-index="0"
              onError=${handleAppLogoLoadError}
            />
          </div>
          ${!collapsed && html`<div class="sidebar-title">Bosun</div>`}
        </div>
        <button
          class="sidebar-collapse-btn"
          onClick=${onToggle}
          title=${collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label=${collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          ${collapseIcon}
        </button>
      </div>
      ${!collapsed && html`
        <div class="sidebar-actions">
          <button class="btn btn-primary btn-block" onClick=${() => createSession({ type: "primary" })}>
            <span class="btn-icon">${resolveIcon(":plus:")}</span> New Session
          </button>
          <button class="btn btn-ghost btn-block" onClick=${() => navigateTo("tasks")}>
            <span class="btn-icon">${resolveIcon(":clipboard:")}</span> View Tasks
          </button>
        </div>
      `}
      ${collapsed && html`
        <div class="sidebar-actions-icon">
          <button
            class="sidebar-icon-action"
            onClick=${() => createSession({ type: "primary" })}
            title="New Session"
            aria-label="New Session"
          >${resolveIcon(":plus:")}</button>
        </div>
      `}
      <nav class="sidebar-nav" aria-label="Main navigation">
        ${TAB_CONFIG.map((tab) => {
          const isActive = activeTab.value === tab.id;
          const isHome = tab.id === "dashboard";
          const isChild = !!tab.parent;
          let badge = 0;
          if (tab.id === "tasks") {
            badge = getActiveTaskCount();
          } else if (tab.id === "agents") {
            badge = getActiveAgentCount();
          }
          return html`
            <button
              key=${tab.id}
              class="sidebar-nav-item ${isActive ? "active" : ""} ${isChild ? "sidebar-nav-child" : ""}"
              style="position:relative"
              aria-label=${tab.label}
              aria-current=${isActive ? "page" : null}
              title=${collapsed ? tab.label : undefined}
              onClick=${() =>
                navigateTo(tab.id, {
                  resetHistory: isHome,
                  forceRefresh: isHome && isActive,
                })}
            >
              ${ICONS[tab.icon]}
              ${!collapsed && html`<span>${tab.label}</span>`}
              ${badge > 0 ? html`<span class="nav-badge" title=${tab.id === "tasks" ? "Active work items" : "Active agents"}>${badge}</span>` : null}
            </button>
          `;
        })}
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-status ${isConn ? "online" : "offline"}" title=${collapsed ? (isConn ? "Connected" : "Offline") : undefined}>
          <span class="sidebar-status-dot"></span>
          ${!collapsed && (isConn ? "Connected" : "Offline")}
        </div>
        ${!collapsed && (user
          ? html`<div class="sidebar-user">@${user.username || user.first_name || "operator"}</div>`
          : html`<div class="sidebar-user">Operator Console</div>`)}
      </div>
    </aside>
  `;
}

function SessionRail({ onResizeStart, onResizeReset, showResizer, collapsed, onCollapse, onExpand, sessionType = "primary" }) {
  const [showArchived, setShowArchived] = useState(false);
  const sessions = sessionsData.value || [];
  const activeCount = sessions.filter(
    (s) => s.status === "active" || s.status === "running",
  ).length;

  useEffect(() => {
    // Session polling belongs to the active tab (Chat/Agents). The rail only
    // performs a one-time fallback load to avoid filter thrash/flicker.
    if ((sessionsData.value || []).length > 0) return;
    void loadSessions({ type: sessionType }).catch(() => {});
  }, [sessionType]);

  useEffect(() => {
    if (selectedSessionId.value || sessions.length === 0) return;
    const next =
      sessions.find((s) => s.status === "active" || s.status === "running") ||
      sessions[0];
    if (next?.id) selectedSessionId.value = next.id;
  }, [sessionsData.value, selectedSessionId.value]);

  if (collapsed) {
    // Icon-only strip: colored dots for sessions + expand button
    const dots = sessions.slice(0, 12);
    const statusColor = (s) => {
      if (s.status === "active" || s.status === "running") return "var(--color-done, #10b981)";
      if (s.status === "error" || s.status === "failed") return "var(--color-error, #ef4444)";
      if (s.status === "archived") return "rgba(255,255,255,0.2)";
      return "rgba(255,255,255,0.35)";
    };

    return html`
      <aside class="session-rail session-rail--collapsed" aria-label="Sessions (collapsed)">
        <button
          class="rail-expand-btn"
          onClick=${onExpand}
          title="Expand sessions panel"
          aria-label="Expand sessions"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14">
            <path d="M6 3l5 5-5 5"/>
          </svg>
        </button>
        <div class="rail-dots">
          ${dots.map((s) => html`
            <div
              key=${s.id}
              class="rail-session-dot ${selectedSessionId.value === s.id ? 'selected' : ''}"
              style="background: ${statusColor(s)}"
              onClick=${() => { selectedSessionId.value = s.id; onExpand?.(); }}
              title=${s.title || s.taskId || s.id}
            />
          `)}
          ${sessions.length > 12 && html`
            <div class="rail-dots-more" title="${sessions.length - 12} more sessions">
              +${sessions.length - 12}
            </div>
          `}
        </div>
        <div class="rail-icon-footer">
          <div
            class="rail-active-count"
            title="${activeCount} active session${activeCount !== 1 ? 's' : ''}"
          >${activeCount > 0 ? activeCount : ''}</div>
        </div>
      </aside>
    `;
  }

  return html`
    <aside class="session-rail">
      <div class="rail-header">
        <div class="rail-header-inner">
          <div class="rail-title">Sessions</div>
          <div class="rail-meta">
            ${activeCount} active · ${sessions.length} total
          </div>
        </div>
        <button
          class="rail-collapse-btn"
          onClick=${onCollapse}
          title="Collapse sessions panel"
          aria-label="Collapse sessions"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14">
            <path d="M10 3l-5 5 5 5"/>
          </svg>
        </button>
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
  const lastActiveLabel = lastActive ? formatRelative(lastActive) : "—";
  const apiStatusLabel = connected.value ? "Connected" : "Offline";
  const wsStatusLabel = wsConnected.value ? "Live" : "Closed";
  const backendLastSeenLabel = backendLastSeen.value
    ? formatRelative(backendLastSeen.value)
    : "—";
  let smartLogsContent = html`
    <div class="inspector-scroll">
      ${smartLogs.map(
        (entry, idx) => html`
          <div key=${idx} class="inspector-log-line ${entry.level}">
            <span class="inspector-log-level">
              ${entry.level.toUpperCase()}
            </span>
            <span class="inspector-log-text">
              ${entry.line.length > 220 ? entry.line.slice(-220) : entry.line}
            </span>
          </div>
        `,
      )}
    </div>
  `;
  if (logState === "error") {
    smartLogsContent = html`<div class="inspector-empty">Log stream unavailable.</div>`;
  } else if (smartLogs.length === 0) {
    smartLogsContent = html`<div class="inspector-empty">No noteworthy logs right now.</div>`;
  }

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
              <div class="inspector-kv"><span>Last Active</span><strong>${lastActiveLabel}</strong></div>
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
              ${smartLogsContent}
              <button class="btn btn-ghost btn-sm" onClick=${() => navigateTo("logs")}>
                Open Logs
              </button>
            </div>
          `
        : html`
            <div class="inspector-section">
              <div class="inspector-title">System Pulse</div>
              <div class="inspector-kv"><span>API</span><strong>${apiStatusLabel}</strong></div>
              <div class="inspector-kv"><span>WebSocket</span><strong>${wsStatusLabel}</strong></div>
              <div class="inspector-kv"><span>Last Seen</span><strong>${backendLastSeenLabel}</strong></div>
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
const MORE_NAV_TABS = ["control", "infra", "logs", "telemetry", "library", "workflows", "settings"];

function getTabsById(ids) {
  return ids
    .map((id) => TAB_CONFIG.find((tab) => tab.id === id))
    .filter(Boolean);
}

function getActiveTaskCount() {
  const sCounts = statusData.value?.counts || {};
  const fromSummary =
    Number(sCounts.running || sCounts.inprogress || 0) +
    Number(sCounts.inreview || sCounts.review || 0);
  const list = Array.isArray(tasksData.value) ? tasksData.value : [];
  const fromList = list.filter((task) => {
    const status = String(task?.status || "").toLowerCase();
    return status === "inprogress" || status === "inreview" || status === "running";
  }).length;
  return Math.max(fromSummary, fromList);
}

function getActiveAgentCount() {
  const slots = Number(executorData.value?.data?.activeSlots || 0);
  const agents = Array.isArray(agentsData.value) ? agentsData.value : [];
  const fromAgents = agents.filter((agent) => {
    const status = String(agent?.status || "").toLowerCase();
    return status === "running" || status === "busy" || status === "active";
  }).length;
  const safeSlots = Number.isFinite(slots) ? Math.max(0, slots) : 0;
  return Math.max(safeSlots, fromAgents);
}

function BottomNav({ compact, moreOpen, onToggleMore, onNavigate }) {
  const primaryTabs = getTabsById(PRIMARY_NAV_TABS);
  const tasksBadge = getActiveTaskCount();
  const agentsBadge = getActiveAgentCount();
  return html`
    <nav class=${`bottom-nav ${compact ? "compact" : ""}`}>
      ${primaryTabs.map((tab) => {
        const isHome = tab.id === "dashboard";
        const isActive = activeTab.value === tab.id;
        let badge = 0;
        if (tab.id === "tasks") badge = tasksBadge;
        else if (tab.id === "agents") badge = agentsBadge;
        return html`
          <button
            key=${tab.id}
            class="nav-item ${isActive ? "active" : ""}"
            style="position:relative"
            aria-label=${`Go to ${tab.label}`}
            type="button"
            onClick=${() =>
              onNavigate(tab.id, {
                resetHistory: isHome,
                forceRefresh: isHome && isActive,
              })}
          >
            ${ICONS[tab.icon]}
            <span class="nav-label">${tab.label}</span>
            ${badge > 0 ? html`<span class="nav-badge" title=${tab.id === "tasks" ? "Active work items" : "Active agents"}>${badge}</span>` : null}
          </button>
        `;
      })}
      <button
        class="nav-item nav-item-more ${moreOpen ? "active" : ""}"
        aria-haspopup="dialog"
        aria-expanded=${moreOpen ? "true" : "false"}
        aria-label=${moreOpen ? "Close more menu" : "Open more menu"}
        type="button"
        onClick=${onToggleMore}
      >
        ${ICONS.ellipsis}
        <span class="nav-label">More</span>
      </button>
    </nav>
  `;
}

function MoreSheet({ open, onClose, onNavigate, onOpenBot }) {
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
        <div class="more-menu-section">
          <div class="more-menu-section-title">Quick Actions</div>
          <button
            class="more-menu-bot-btn"
            type="button"
            aria-label="Open Bot Controls"
            onClick=${() => { onClose(); onOpenBot?.(); }}
          >
            <span class="more-menu-bot-icon">${resolveIcon("bot")}</span>
            <div class="more-menu-bot-text">
              <span class="more-menu-bot-label">Bot Controls</span>
              <span class="more-menu-bot-sub">Commands, executor, routing</span>
            </div>
            <span class="more-menu-bot-chevron">›</span>
          </button>
        </div>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  Bot Controls — multi-level command panel
 *  Triggered from the "More" sheet (not a floating FAB so it
 *  doesn't obscure content on small screens / mobile).
 * ═══════════════════════════════════════════════ */
const BOT_SCREENS = {
  home: {
    title: ":sliders: Bosun Control Center",
    body: "Manage your automation fleet.",
    keyboard: [
      [{ text: ":chart: Status", cmd: "/status" }, { text: ":clipboard: Tasks", cmd: "/tasks" }, { text: ":bot: Agents", cmd: "/agents" }],
      [{ text: ":settings: Executor", go: "executor" }, { text: ":server: Routing", go: "routing" }, { text: ":git: Workspaces", go: "workspaces" }],
      [{ text: ":folder: Logs", cmd: "/logs" }, { text: ":heart: Health", cmd: "/health" }, { text: ":refresh: Refresh", cmd: "/status" }],
    ],
  },
  executor: {
    title: ":settings: Executor",
    parent: "home",
    body: "Task execution slots, pause, resume, and parallelism.",
    keyboard: [
      [{ text: ":chart: Status", cmd: "/executor" }, { text: ":pause: Pause", cmd: "/pause" }, { text: ":play: Resume", cmd: "/resume" }],
      [{ text: ":hash: Max Parallel", go: "maxparallel" }, { text: ":repeat: Retry Active", cmd: "/retrytask" }],
    ],
  },
  maxparallel: {
    title: ":hash: Max Parallel Slots",
    parent: "executor",
    body: "Set the maximum number of concurrent task slots.",
    keyboard: [
      [{ text: "1", cmd: "/parallelism 1" }, { text: "2", cmd: "/parallelism 2" }, { text: "3", cmd: "/parallelism 3" }],
      [{ text: "4", cmd: "/parallelism 4" }, { text: "6", cmd: "/parallelism 6" }, { text: "8", cmd: "/parallelism 8" }],
      [{ text: "12", cmd: "/parallelism 12" }, { text: "16", cmd: "/parallelism 16" }],
    ],
  },
  routing: {
    title: ":server: Routing & SDKs",
    parent: "home",
    body: "SDK routing, kanban binding, and version info.",
    keyboard: [
      [{ text: ":bot: SDK Status", cmd: "/sdk" }, { text: ":clipboard: Kanban", cmd: "/kanban" }],
      [{ text: ":globe: Version", cmd: "/version" }, { text: ":help: Help", cmd: "/help" }],
    ],
  },
  workspaces: {
    title: ":git: Workspaces",
    parent: "home",
    body: "Git worktrees, logs, and task planning.",
    keyboard: [
      [{ text: ":chart: Fleet Status", cmd: "/status" }, { text: ":folder: Logs", cmd: "/logs" }],
      [{ text: ":grid: Planner", go: "planner" }, { text: ":check: Start Task", cmd: "/starttask" }],
    ],
  },
  planner: {
    title: ":grid: Task Planner",
    parent: "workspaces",
    body: "Seed new tasks from the backlog into the active queue.",
    keyboard: [
      [{ text: "Plan 3", cmd: "/plan 3" }, { text: "Plan 5", cmd: "/plan 5" }, { text: "Plan 10", cmd: "/plan 10" }],
    ],
  },
};

function BotControlsSheet({ open, onClose }) {
  const [screen, setScreen] = useState("home");
  const [navStack, setNavStack] = useState([]);
  const [cmdOutput, setCmdOutput] = useState(null);
  const [cmdLoading, setCmdLoading] = useState(false);
  const [cmdError, setCmdError] = useState(null);

  const currentDef = BOT_SCREENS[screen] || BOT_SCREENS.home;

  const botNavigateTo = useCallback((screenId) => {
    setNavStack((s) => [...s, screen]);
    setScreen(screenId);
    setCmdOutput(null);
    setCmdError(null);
  }, [screen]);

  const botGoBack = useCallback(() => {
    setNavStack((s) => {
      const next = [...s];
      const prev = next.pop() || "home";
      setScreen(prev);
      setCmdOutput(null);
      setCmdError(null);
      return next;
    });
  }, []);

  const botGoHome = useCallback(() => {
    setNavStack([]);
    setScreen("home");
    setCmdOutput(null);
    setCmdError(null);
  }, []);

  const handleBotClose = useCallback(() => {
    onClose();
    // Reset navigation state after the sheet's close animation (~300ms)
    setTimeout(() => {
      setScreen("home");
      setNavStack([]);
      setCmdOutput(null);
      setCmdError(null);
    }, 320);
  }, [onClose]);

  const runBotCommand = useCallback(async (cmd) => {
    if (cmdLoading) return;
    setCmdLoading(true);
    setCmdOutput(null);
    setCmdError(null);
    try {
      const result = await apiFetch("/api/command", {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
        _silent: true,
      });
      if (result?.ok) {
        const d = result.data;
        if (d?.content) {
          setCmdOutput(d.content);
        } else if (d?.executed === false && d?.error) {
          setCmdError(d.error);
        } else {
          setCmdOutput(`:check: ${cmd} sent.`);
        }
      } else {
        setCmdError(result?.error || "Command failed");
      }
    } catch (err) {
      setCmdError(err.message || "Connection error — is bosun running?");
    } finally {
      setCmdLoading(false);
    }
  }, [cmdLoading]);

  return html`
    <${Modal}
      title=${iconText(currentDef.title)}
      open=${open}
      onClose=${handleBotClose}
      contentClassName="bot-controls-content"
    >
      <div class="bot-controls">
        ${navStack.length > 0 ? html`
          <div class="bot-controls-breadcrumb">
            <button class="btn btn-ghost btn-sm" type="button" onClick=${botGoBack} aria-label="Go back">
              ← Back
            </button>
            ${navStack.length > 1 ? html`
              <button class="btn btn-ghost btn-sm" type="button" onClick=${botGoHome} aria-label="Go to home">
                ${iconText(":home: Home")}
              </button>
            ` : null}
          </div>
        ` : null}

        ${currentDef.body ? html`<p class="bot-controls-body">${iconText(currentDef.body)}</p>` : null}

        ${cmdLoading ? html`
          <div class="bot-controls-spinner">
            <div class="ptr-spinner-icon"></div>
            <span>Running…</span>
          </div>
        ` : null}

        ${cmdError && !cmdLoading ? html`
          <div class="bot-controls-result bot-controls-result-error">${iconText(`:close: ${cmdError}`)}</div>
        ` : null}

        ${cmdOutput && !cmdLoading && !cmdError ? html`
          <div class="bot-controls-result"><pre>${iconText(cmdOutput)}</pre></div>
        ` : null}

        <div class="bot-controls-keyboard">
          ${currentDef.keyboard.map((row, ri) => html`
            <div key=${ri} class="bot-kb-row">
              ${row.map((btn, bi) => html`
                <button
                  key=${bi}
                  type="button"
                  class="bot-kb-btn ${btn.go ? "nav-btn" : ""}"
                  disabled=${cmdLoading}
                  onClick=${() => btn.go ? botNavigateTo(btn.go) : runBotCommand(btn.cmd)}
                >
                  ${iconText(btn.text)}
                </button>
              `)}
            </div>
          `)}
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const mainRef = useRef(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollVisibilityRef = useRef(false);

  // ── Top loading bar state ──
  const [loadingPct, setLoadingPct] = useState(0);
  const [loadingVisible, setLoadingVisible] = useState(false);
  const loadingTimerRef = useRef(null);
  const isLoading = loadingCount.value > 0;
  useEffect(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    if (isLoading) {
      // Avoid flashing the top bar for short background activity.
      loadingTimerRef.current = setTimeout(() => {
        setLoadingVisible(true);
        setLoadingPct(70);
        loadingTimerRef.current = null;
      }, 180);
    } else {
      setLoadingPct(100);
      loadingTimerRef.current = setTimeout(() => {
        setLoadingVisible(false);
        setLoadingPct(0);
        loadingTimerRef.current = null;
      }, 220);
    }
    return () => {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
    };
  }, [isLoading]);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);
  const [voiceTier, setVoiceTier] = useState(2);
  const [voiceSessionId, setVoiceSessionId] = useState(null);
  const [voiceExecutor, setVoiceExecutor] = useState(null);
  const [voiceAgentMode, setVoiceAgentMode] = useState(null);
  const [voiceModel, setVoiceModel] = useState(null);
  const [voiceCallType, setVoiceCallType] = useState("voice");
  const [voiceInitialVisionSource, setVoiceInitialVisionSource] = useState(
    null,
  );
  const followWindowMode = isFollowWindowFromUrl();
  const followOverlayOpenedRef = useRef(false);
  const [floatingCallState, setFloatingCallState] = useState(() =>
    readFloatingCallState(),
  );
  const resizeRef = useRef(null);
  const [isCompactNav, setIsCompactNav] = useState(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return false;
    return win.matchMedia(`(max-width: ${COMPACT_NAV_MAX_WIDTH}px)`).matches;
  });
  const [isDesktop, setIsDesktop] = useState(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return false;
    return win.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`).matches;
  });
  const [isTablet, setIsTablet] = useState(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return false;
    const w = win.innerWidth;
    return w >= TABLET_MIN_WIDTH && w < DESKTOP_MIN_WIDTH;
  });
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(() => {
    if (!globalThis.window) return 280;
    const stored = Number(localStorage.getItem("ve-rail-width"));
    // Ensure a sensible default — never start at 0 or very small
    return Number.isFinite(stored) && stored >= RAIL_ICON_WIDTH ? stored : 280;
  });
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (!globalThis.window) return 320;
    const stored = Number(localStorage.getItem("ve-inspector-width"));
    return Number.isFinite(stored) ? stored : 320;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (!globalThis.window) return false;
    return localStorage.getItem("ve-sidebar-collapsed") === "true";
  });
  const [railCollapsed, setRailCollapsed] = useState(() => {
    if (!globalThis.window) return false;
    return localStorage.getItem("ve-rail-collapsed") === "true";
  });
  const railWidthBeforeCollapseRef = useRef(280);

  const clamp = useCallback((value, min, max) => {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }, []);

  const handleResizeMove = useCallback((event) => {
    const state = resizeRef.current;
    if (!state) return;
    const delta = event.clientX - state.startX;
    if (state.type === "rail") {
      const next = clamp(state.startRail + delta, RAIL_ICON_WIDTH, 440);
      setRailWidth(next);
    } else {
      const next = clamp(state.startInspector - delta, 260, 440);
      setInspectorWidth(next);
    }
  }, [clamp]);

  const handleResizeEnd = useCallback(() => {
    const state = resizeRef.current;
    resizeRef.current = null;
    document.body.classList.remove("is-resizing");
    globalThis.removeEventListener?.("pointermove", handleResizeMove);
    globalThis.removeEventListener?.("pointerup", handleResizeEnd);

    // Snap rail to icon mode if dragged to near-minimum
    if (state?.type === "rail") {
      if (railWidth <= RAIL_ICON_WIDTH + 20) {
        railWidthBeforeCollapseRef.current = Math.max(state.startRail, 200);
        setRailCollapsed(true);
        setRailWidth(RAIL_ICON_WIDTH);
        try { localStorage.setItem("ve-rail-collapsed", "true"); } catch {}
      }
    }
  }, [handleResizeMove, railWidth]);

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
      globalThis.addEventListener?.("pointermove", handleResizeMove);
      globalThis.addEventListener?.("pointerup", handleResizeEnd);
    },
    [isDesktop, railWidth, inspectorWidth, handleResizeMove, handleResizeEnd],
  );

  const handleResizeReset = useCallback((type) => {
    if (type === "rail") setRailWidth(320);
    if (type === "inspector") setInspectorWidth(320);
  }, []);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    const query = win.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => {
      query.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    const query = win.matchMedia(`(max-width: ${COMPACT_NAV_MAX_WIDTH}px)`);
    const update = () => setIsCompactNav(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => {
      query.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    const tabletQuery = win.matchMedia(
      `(min-width: ${TABLET_MIN_WIDTH}px) and (max-width: ${DESKTOP_MIN_WIDTH - 1}px)`,
    );
    const update = () => setIsTablet(tabletQuery.matches);
    update();
    tabletQuery.addEventListener?.("change", update);
    return () => {
      tabletQuery.removeEventListener?.("change", update);
    };
  }, []);


  useEffect(() => {
    if (!isDesktop || !globalThis.window) return;
    if (!railCollapsed) localStorage.setItem("ve-rail-width", String(railWidth));
  }, [railWidth, isDesktop, railCollapsed]);

  useEffect(() => {
    if (!isDesktop || !globalThis.window) return;
    localStorage.setItem("ve-inspector-width", String(inspectorWidth));
  }, [inspectorWidth, isDesktop]);

  useEffect(() => {
    if (!globalThis.window) return;
    try { localStorage.setItem("ve-sidebar-collapsed", String(sidebarCollapsed)); } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!globalThis.window) return;
    try { localStorage.setItem("ve-rail-collapsed", String(railCollapsed)); } catch {}
  }, [railCollapsed]);

  // Listen for expand-rail from chat tab / other places
  useEffect(() => {
    const handler = () => {
      if (!railCollapsed) return;
      setRailCollapsed(false);
      const restoredWidth = railWidthBeforeCollapseRef.current || 280;
      setRailWidth(Math.max(restoredWidth, 200));
    };
    globalThis.addEventListener?.("ve:expand-rail", handler);
    return () => globalThis.removeEventListener?.("ve:expand-rail", handler);
  }, [railCollapsed]);

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

  // ── Bot Controls sheet state ──
  const [isBotOpen, setIsBotOpen] = useState(false);
  const openBot  = useCallback(() => setIsBotOpen(true), []);
  const closeBot = useCallback(() => setIsBotOpen(false), []);

  const handleNavigate = useCallback((tabId, options = {}) => {
    setIsMoreOpen(false);
    navigateTo(tabId, options);
  }, []);

  const toggleMore = useCallback(() => {
    setIsMoreOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (typeof globalThis === "undefined") return;
    const handler = () => {
      setIsMoreOpen(false);
      setIsBotOpen(false);
      setShowShortcuts(false);
    };
    globalThis.addEventListener("ve:close-modals", handler);
    return () => globalThis.removeEventListener("ve:close-modals", handler);
  }, []);

  useEffect(() => {
    setIsMoreOpen(false);
    setIsBotOpen(false);
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

    // Load initial data for the route-selected tab, then apply stored defaults.
    refreshTab(activeTab.value || "dashboard", {
      background: true,
      manual: false,
    }).then(() => applyStoredDefaults());

    // Global keyboard shortcuts (1-7 for tabs, Escape for modals)
    function handleGlobalKeys(e) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (document.activeElement?.isContentEditable) return;

      // Number keys 1-8 to switch tabs
      const num = Number.parseInt(e.key, 10);
      if (num >= 1 && num <= 8 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tabCfg = TAB_CONFIG[num - 1];
        if (tabCfg) {
          e.preventDefault();
          navigateTo(tabCfg.id);
        }
        return;
      }

      // "c" to create task (when not in a form element)
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        globalThis.dispatchEvent(new CustomEvent("ve:create-task"));
        return;
      }

      // "?" to toggle keyboard shortcuts help
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      // Escape to close modals/palette
      if (e.key === "Escape") {
        globalThis.dispatchEvent(new CustomEvent("ve:close-modals"));
        setShowShortcuts(false);
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
    const onBeforeUnload = (event) => {
      if (!hasPendingChanges.value) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener?.("beforeunload", onBeforeUnload);
    return () => globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const handleOpenVoiceMode = async (event) => {
      try {
        const requestedCallType =
          String(event?.detail?.call || "").trim().toLowerCase() === "video"
            ? "video"
            : "voice";
        const requestedVisionSourceRaw = String(
          event?.detail?.initialVisionSource || "",
        )
          .trim()
          .toLowerCase();
        const requestedVisionSource =
          requestedVisionSourceRaw === "camera" ||
          requestedVisionSourceRaw === "screen"
            ? requestedVisionSourceRaw
            : requestedCallType === "video"
              ? "camera"
              : null;
        const currentExecutor =
          String(event?.detail?.executor || activeAgent.value || "").trim() ||
          null;
        const currentMode =
          String(event?.detail?.mode || agentMode.value || "").trim() || null;
        const currentModel =
          String(event?.detail?.model || selectedModel.value || "").trim() ||
          null;
        const explicitSessionId =
          String(event?.detail?.sessionId || "").trim() || null;
        let currentSessionId =
          explicitSessionId ||
          (selectedSessionId.value ? String(selectedSessionId.value) : null);

        // Ensure voice calls always bind to a real chat session so transcript +
        // delegated agent output are persisted in shared history.
        if (!currentSessionId) {
          const created = await createSession({
            type: "primary",
            agent: currentExecutor || undefined,
            mode: currentMode || undefined,
            model: currentModel || undefined,
          });
          const createdId = String(created?.session?.id || "").trim();
          currentSessionId = createdId || null;
          if (currentSessionId) {
            selectedSessionId.value = currentSessionId;
          }
        }

        if (!currentSessionId) {
          showToast("Could not create a chat session for voice mode.", "error");
          return;
        }

        setVoiceSessionId(currentSessionId);
        setVoiceExecutor(currentExecutor);
        setVoiceAgentMode(currentMode);
        setVoiceModel(currentModel);
        setVoiceCallType(requestedCallType);
        setVoiceInitialVisionSource(requestedVisionSource);

        const response = await fetch("/api/voice/config", { method: "GET" });
        const cfg = response.ok ? await response.json() : null;
        if (!cfg?.available) {
          showToast(cfg?.reason || "Voice mode is not available.", "error");
          return;
        }
        setVoiceTier(Number(cfg?.tier) === 1 ? 1 : 2);
        setVoiceOverlayOpen(true);
      } catch (err) {
        showToast(
          `Could not open voice mode: ${err?.message || "unknown error"}`,
          "error",
        );
      }
    };

    globalThis.addEventListener?.("ve:open-voice-mode", handleOpenVoiceMode);
    return () =>
      globalThis.removeEventListener?.("ve:open-voice-mode", handleOpenVoiceMode);
  }, [followWindowMode]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event?.key && event.key !== FLOATING_CALL_STATE_KEY) return;
      setFloatingCallState(readFloatingCallState());
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!followWindowMode) return;
    const nextFloatingState = {
      active: Boolean(voiceOverlayOpen),
      call: voiceCallType,
    };
    setFloatingCallState(nextFloatingState);
    writeFloatingCallState(nextFloatingState);
  }, [followWindowMode, voiceOverlayOpen, voiceCallType]);

  useEffect(() => {
    if (!followWindowMode) return;
    if (voiceOverlayOpen) {
      followOverlayOpenedRef.current = true;
      return;
    }
    if (!followOverlayOpenedRef.current) return;
    globalThis?.veDesktop?.follow?.hide?.().catch?.(() => {});
  }, [followWindowMode, voiceOverlayOpen]);

  useEffect(() => {
    const launch = parseVoiceLaunchFromUrl();
    if (!launch) return;
    let cancelled = false;

    const start = async () => {
      if (launch.tab === "chat") {
        const launchSessionId = String(launch.detail?.sessionId || "").trim();
        if (launchSessionId) {
          selectedSessionId.value = launchSessionId;
          navigateTo("chat", {
            params: { sessionId: launchSessionId },
            replace: true,
            skipGuard: true,
          });
        } else {
          navigateTo("chat", { replace: true, skipGuard: true });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (cancelled) return;
      globalThis.dispatchEvent?.(
        new CustomEvent("ve:open-voice-mode", { detail: launch.detail }),
      );
    };

    start()
      .catch(() => {})
      .finally(() => {
        scrubVoiceLaunchQuery();
      });

    return () => {
      cancelled = true;
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
    const swipeTabs = TAB_CONFIG.filter((t) => t.id !== "settings" && !t.parent);
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;
    let blocked = false;

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const target = e.target;
      blocked = shouldBlockTabSwipe(target, activeTab.value);
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
  const isChatOrAgents = activeTab.value === "chat" || activeTab.value === "agents" || activeTab.value === "fleet-sessions";
  const isChat = activeTab.value === "chat";
  const showSessionRail = isDesktop && isChat;
  const showInspector = isDesktop && isChatOrAgents;
  const showBottomNav = !isDesktop;
  const railSessionType = "primary";
  const showDrawerToggles = isTablet;
  const showInspectorToggle = isTablet && isChatOrAgents;
  const showRestoreFloatingCall =
    !followWindowMode &&
    floatingCallState?.active === true &&
    typeof globalThis?.veDesktop?.follow?.restore === "function";
  const floatingCallLabel =
    String(floatingCallState?.call || "").trim().toLowerCase() === "video"
      ? "Restore floating video call"
      : "Restore floating voice call";

  const shellStyle = isDesktop
    ? {
        "--rail-width": railCollapsed ? `${RAIL_ICON_WIDTH}px` : `${railWidth}px`,
        "--sidebar-width": sidebarCollapsed ? `${SIDEBAR_ICON_WIDTH}px` : undefined,
        "--inspector-width": `${inspectorWidth}px`,
      }
    : null;

  const toggleSidebar = useCallback(() => {
    setSidebarDrawerOpen((v) => !v);
    setInspectorDrawerOpen(false);
  }, []);

  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((v) => !v), []);

  const collapseRail = useCallback(() => {
    railWidthBeforeCollapseRef.current = railWidth;
    setRailCollapsed(true);
  }, [railWidth]);

  const expandRail = useCallback(() => {
    setRailCollapsed(false);
    setRailWidth(railWidthBeforeCollapseRef.current || 280);
  }, []);

  const toggleInspector = useCallback(() => {
    setInspectorDrawerOpen((v) => !v);
    setSidebarDrawerOpen(false);
  }, []);

  const closeDrawers = useCallback(() => {
    setSidebarDrawerOpen(false);
    setInspectorDrawerOpen(false);
  }, []);
  const inspectorToggleLabel = inspectorDrawerOpen
    ? "Close inspector"
    : "Open inspector";
  const inspectorToggleButton = showInspectorToggle
    ? html`
        <button
          class="btn btn-ghost btn-sm tablet-toggle"
          onClick=${toggleInspector}
          aria-label=${inspectorToggleLabel}
        >
          <span class="btn-icon">${resolveIcon("clipboard")}</span>
          Inspector
        </button>
      `
    : null;
  const moreToggleButton = showDrawerToggles
    ? html`
        <button
          class="btn btn-ghost btn-sm tablet-toggle"
          onClick=${toggleMore}
          aria-label=${isMoreOpen ? "Close navigation menu" : "Open navigation menu"}
        >
          ⋯ Navigation
        </button>
      `
    : null;

  return html`
    <div class="top-loading-bar" style="width: ${loadingPct}%; opacity: ${loadingVisible ? 1 : 0}"></div>
    <div
      class="app-shell"
      style=${shellStyle}
      data-tab=${activeTab.value}
      data-has-rail=${showSessionRail ? "true" : "false"}
      data-has-inspector=${showInspector ? "true" : "false"}
      data-sidebar-collapsed=${sidebarCollapsed ? "true" : undefined}
      data-rail-collapsed=${railCollapsed ? "true" : undefined}
    >
      <${SidebarNav} collapsed=${sidebarCollapsed} onToggle=${toggleSidebarCollapsed} />

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
            showResizer=${isDesktop && !railCollapsed}
            collapsed=${railCollapsed}
            onCollapse=${collapseRail}
            onExpand=${expandRail}
            sessionType=${railSessionType}
          />`
        : null}
      <div class="app-main">
        <div class="main-panel">
          <${Header} />

          ${/* Tablet action bar with drawer toggles */ ""}
          ${showDrawerToggles
            ? html`
                <div class="tablet-action-bar">
                  ${inspectorToggleButton}
                  ${moreToggleButton}
                </div>
              `
            : null}

          ${backendDown.value ? html`<${OfflineBanner} />` : null}
          <${ToastContainer} />
          <${CommandPalette} open=${paletteOpen} onClose=${paletteClose} />
          ${showShortcuts ? html`<${KeyboardShortcutsModal} onClose=${() => setShowShortcuts(false)} />` : null}
          <${PullToRefresh}
            onRefresh=${() => refreshTab(activeTab.value)}
            disabled=${activeTab.value === "chat"}
          >
            <main class=${`main-content${showBottomNav && isCompactNav ? " compact" : ""}`} ref=${mainRef}>
              <${TabErrorBoundary} key=${activeTab.value} tabName=${activeTab.value}>
                <${CurrentTab} />
              <//>
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
    ${showBottomNav
      ? html`<${BottomNav}
          compact=${isCompactNav}
          moreOpen=${isMoreOpen}
          onToggleMore=${toggleMore}
          onNavigate=${handleNavigate}
        />`
      : null}
    <${MoreSheet}
      open=${isMoreOpen}
      onClose=${closeMore}
      onNavigate=${handleNavigate}
      onOpenBot=${openBot}
    />
    <${BotControlsSheet}
      open=${isBotOpen}
      onClose=${closeBot}
    />
    ${showRestoreFloatingCall
      ? html`
          <button
            class="btn btn-primary floating-call-restore"
            title=${floatingCallLabel}
            onClick=${async () => {
              try {
                const result = await globalThis.veDesktop.follow.restore();
                if (!result?.ok) {
                  const nextFloatingState = { active: false, call: floatingCallState?.call };
                  setFloatingCallState(nextFloatingState);
                  writeFloatingCallState(nextFloatingState);
                  showToast("No floating call window is active.", "info");
                }
              } catch {
                showToast("Could not restore floating call window.", "error");
              }
            }}
          >
            ${resolveIcon("phone")}
            ${String(floatingCallState?.call || "").trim().toLowerCase() === "video"
              ? " Restore Video Call"
              : " Restore Voice Call"}
          </button>
        `
      : null}
    <${VoiceOverlay}
      visible=${voiceOverlayOpen}
      onClose=${() => setVoiceOverlayOpen(false)}
      onDismiss=${() => {
        if (followWindowMode && globalThis?.veDesktop?.follow?.hide) {
          globalThis.veDesktop.follow.hide().catch(() => {});
          return;
        }
        setVoiceOverlayOpen(false);
      }}
      tier=${voiceTier}
      sessionId=${voiceSessionId}
      executor=${voiceExecutor}
      mode=${voiceAgentMode}
      model=${voiceModel}
      callType=${voiceCallType}
      initialVisionSource=${voiceInitialVisionSource}
      compact=${followWindowMode}
    />
  `;
}

/* ─── Mount ─── */
const mountRoot = () => document.getElementById("app");
const mountApp = () => {
  const root = mountRoot();
  if (!root) return;
  preactRender(html`<${App} />`, root);
};
const remountApp = () => {
  const root = mountRoot();
  if (!root) return;
  try {
    preactRender(null, root);
  } catch {
    root.replaceChildren();
  }
  preactRender(html`<${App} />`, root);
};
globalThis.__veRemountApp = remountApp;
mountApp();
