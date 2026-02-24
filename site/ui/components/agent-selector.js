/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Agent Selector
 *  Agent mode selector, model/adapter picker, status badge
 *  Sits in the chat input toolbar area (VS Code Copilot-style)
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "preact/hooks";
import { signal, computed, effect } from "@preact/signals";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { haptic } from "../modules/telegram.js";
import {
  aliveAgentCount,
  staleAgentCount,
  totalErrorCount,
} from "../modules/agent-events.js";

const html = htm.bind(h);

/* ═══════════════════════════════════════════════
 *  Signals
 * ═══════════════════════════════════════════════ */

/** Current agent interaction mode */
export const agentMode = signal("agent"); // "ask" | "agent" | "plan"

/** Available agents loaded from API */
export const availableAgents = signal([]); // Array<{ id, name, provider, available, busy, capabilities }>

/** Currently active agent adapter id */
export const activeAgent = signal("codex-sdk");

/** Whether agent data is currently loading */
export const agentSelectorLoading = signal(false);

/** Agent runtime status (set externally or via WS events) */
export const agentStatus = signal("idle"); // "idle" | "thinking" | "executing" | "streaming"

/** Yolo (auto-approve) mode — skips confirmation prompts in supported agents */
export const yoloMode = signal(false);
// Hydrate from localStorage in browser
try { if (typeof localStorage !== "undefined") yoloMode.value = localStorage.getItem("ve-yolo-mode") === "true"; } catch {}

/** Computed: resolved active agent object */
export const activeAgentInfo = computed(() => {
  const agents = availableAgents.value;
  const id = activeAgent.value;
  return agents.find((a) => a.id === id) || null;
});

/* ═══════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════ */

const MODES = [
  { id: "ask", label: "Ask", icon: "💬", description: "Ask a question" },
  { id: "agent", label: "Agent", icon: "🤖", description: "Autonomous agent" },
  { id: "plan", label: "Plan", icon: "📋", description: "Create a plan first" },
];

const AGENT_ICONS = {
  "codex-sdk": "⚡",
  "copilot-sdk": "🤖",
  "claude-sdk": "🧠",
};

const PROVIDER_COLORS = {
  openai: "#10a37f",
  github: "#8b5cf6",
  anthropic: "#d97706",
};

const STATUS_CONFIG = {
  idle: { color: "var(--tg-theme-hint-color, #999)", label: "Ready", pulse: false },
  thinking: { color: "#eab308", label: "Thinking…", pulse: true },
  executing: { color: "#3b82f6", label: "Running…", pulse: true },
  streaming: { color: "#22c55e", label: "Streaming…", pulse: true },
};

/* ═══════════════════════════════════════════════
 *  Styles — injected once
 * ═══════════════════════════════════════════════ */

const AGENT_SELECTOR_STYLES = `
/* ── Agent Mode Pill Group ── */
.agent-mode-group {
  display: inline-flex;
  border-radius: 8px;
  overflow: hidden;
  background: var(--tg-theme-secondary-bg-color, #1e1e2e);
  border: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.agent-mode-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
  border: none;
  background: transparent;
  color: var(--tg-theme-hint-color, #999);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  white-space: nowrap;
  line-height: 1.2;
}
.agent-mode-pill:hover {
  background: rgba(255,255,255,0.05);
  color: var(--tg-theme-text-color, #fff);
}
.agent-mode-pill.active {
  background: var(--tg-theme-button-color, #3b82f6);
  color: var(--tg-theme-button-text-color, #fff);
}
.agent-mode-pill .mode-icon {
  font-size: 11px;
  line-height: 1;
}

/* ── Agent Picker Dropdown ── */
.agent-picker-wrap {
  position: relative;
  flex-shrink: 0;
}
.agent-picker-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  background: var(--tg-theme-secondary-bg-color, #1e1e2e);
  color: var(--tg-theme-text-color, #fff);
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  white-space: nowrap;
  line-height: 1.2;
}
.agent-picker-btn:hover {
  background: rgba(255,255,255,0.05);
  border-color: rgba(255,255,255,0.12);
}
.agent-picker-btn.open {
  border-color: var(--tg-theme-button-color, #3b82f6);
}
.agent-picker-btn .picker-icon {
  font-size: 13px;
  line-height: 1;
}
.agent-picker-chevron {
  font-size: 9px;
  opacity: 0.5;
  transition: transform 0.2s ease;
}
.agent-picker-btn.open .agent-picker-chevron {
  transform: rotate(180deg);
}

/* ── Dropdown Menu ── */
.agent-picker-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 220px;
  background: var(--tg-theme-bg-color, #0f0f23);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  backdrop-filter: blur(16px);
  padding: 4px;
  z-index: 1000;
  animation: agentDropIn 0.15s ease-out;
  overflow: hidden;
}
@keyframes agentDropIn {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.agent-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--tg-theme-text-color, #fff);
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: background 0.15s ease;
  font-size: 13px;
  -webkit-tap-highlight-color: transparent;
}
.agent-picker-item:hover {
  background: rgba(255,255,255,0.06);
}
.agent-picker-item.active {
  background: rgba(59,130,246,0.12);
}
.agent-picker-item-icon {
  font-size: 18px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
  flex-shrink: 0;
}
.agent-picker-item-info {
  flex: 1;
  min-width: 0;
}
.agent-picker-item-name {
  font-weight: 500;
  font-size: 13px;
  line-height: 1.3;
}
.agent-picker-item-provider {
  font-size: 11px;
  color: var(--tg-theme-hint-color, #888);
  line-height: 1.3;
}
.agent-picker-item-end {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.agent-picker-check {
  color: var(--tg-theme-button-color, #3b82f6);
  font-size: 14px;
  font-weight: 700;
}
.agent-picker-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.agent-picker-status-dot.available { background: #22c55e; }
.agent-picker-status-dot.busy      { background: #eab308; }
.agent-picker-status-dot.offline   { background: #6b7280; }

/* ── Provider badge ── */
.agent-provider-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #fff;
  line-height: 1.4;
}

/* ── Agent Status Badge ── */
.agent-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--tg-theme-hint-color, #999);
  white-space: nowrap;
  flex-shrink: 0;
}
.agent-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background 0.3s ease;
}
.agent-status-dot.pulse {
  animation: agentPulse 1.4s ease-in-out infinite;
}
@keyframes agentPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(1.35); }
}
.agent-status-label {
  line-height: 1;
}

/* ── Chat Input Toolbar ── */
.chat-input-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--tg-theme-secondary-bg-color, #1e1e2e);
  border-radius: 10px;
  flex-wrap: nowrap;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.chat-input-toolbar::-webkit-scrollbar { display: none; }
.chat-input-toolbar-spacer {
  flex: 1;
  min-width: 8px;
}

/* ── Dropdown backdrop (mobile) ── */
.agent-picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: transparent;
}

/* ── Responsive ── */
@media (max-width: 480px) {
  .agent-mode-pill {
    padding: 5px 8px;
    font-size: 11px;
  }
  .agent-mode-pill .mode-icon {
    display: none;
  }
  .agent-picker-btn {
    padding: 5px 8px;
    font-size: 11px;
  }
  .agent-picker-dropdown {
    min-width: 200px;
    left: -4px;
  }
  .chat-input-toolbar {
    gap: 6px;
    padding: 5px 6px;
  }
  .agent-status-label {
    display: none;
  }
}
@media (min-width: 1200px) {
  .agent-mode-pill {
    padding: 6px 14px;
    font-size: 13px;
  }
  .agent-picker-dropdown {
    min-width: 260px;
  }
  .chat-input-toolbar {
    gap: 10px;
    padding: 8px 12px;
  }
}

/* ── Yolo Toggle ── */
.yolo-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid rgba(255, 165, 0, 0.25);
  border-radius: 8px;
  background: transparent;
  color: var(--tg-theme-hint-color, #888);
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  white-space: nowrap;
  line-height: 1.2;
  user-select: none;
  flex-shrink: 0;
}
.yolo-toggle:hover {
  background: rgba(255, 165, 0, 0.07);
  border-color: rgba(255, 165, 0, 0.4);
  color: #ffb347;
}
.yolo-toggle.active {
  background: rgba(255, 140, 0, 0.14);
  border-color: rgba(255, 140, 0, 0.55);
  color: #ffa537;
  box-shadow: 0 0 8px rgba(255, 140, 0, 0.2);
}
.yolo-icon {
  font-size: 13px;
  line-height: 1;
}
.yolo-checkbox {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  border: 1.5px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s;
}
.yolo-toggle.active .yolo-checkbox {
  background: #ffa537;
  border-color: #ffa537;
}
.yolo-checkbox::after {
  content: '';
  display: none;
}
.yolo-toggle.active .yolo-checkbox::after {
  content: '✓';
  display: block;
  font-size: 9px;
  color: #1a1200;
  font-weight: 800;
  line-height: 1;
}

/* ── Native Agent Select ── */
.agent-picker-native {
  appearance: none;
  -webkit-appearance: none;
  background: var(--tg-theme-secondary-bg-color, #1e1e2e);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  color: var(--tg-theme-text-color, #fff);
  font-size: 12px;
  font-weight: 500;
  padding: 5px 28px 5px 28px;
  cursor: pointer;
  min-width: 120px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%23999' d='M1 3l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  transition: border-color 0.2s ease;
}
.agent-picker-native:hover {
  border-color: rgba(255,255,255,0.15);
}
.agent-picker-native:focus {
  outline: none;
  border-color: var(--tg-theme-button-color, #3b82f6);
}
.agent-picker-native option {
  background: #1a1a2e;
  color: #fff;
}
`;

let _agentStylesInjected = false;
function injectAgentSelectorStyles() {
  if (_agentStylesInjected) return;
  _agentStylesInjected = true;
  const el = document.createElement("style");
  el.id = "agent-selector-styles";
  el.textContent = AGENT_SELECTOR_STYLES;
  document.head.appendChild(el);
}

/* ═══════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════ */

/**
 * Fetch available agents from the API and populate signals.
 */
export async function loadAvailableAgents() {
  agentSelectorLoading.value = true;
  try {
    const res = await apiFetch("/api/agents/available", { _silent: true });
    const agents = Array.isArray(res) ? res : (res?.agents || res?.data || []);
    availableAgents.value = agents;
    // If the current activeAgent is not in the list, select the first available
    if (agents.length > 0 && !agents.find((a) => a.id === activeAgent.value)) {
      activeAgent.value = agents[0].id;
    }
  } catch (err) {
    console.warn("[agent-selector] Failed to load agents:", err);
    // Provide sensible fallback agents for offline/dev mode
    if (availableAgents.value.length === 0) {
      availableAgents.value = [
        { id: "codex-sdk", name: "Codex", provider: "openai", available: true, busy: false, capabilities: ["agent", "plan"] },
        { id: "copilot-sdk", name: "Copilot", provider: "github", available: true, busy: false, capabilities: ["ask", "agent", "plan"] },
        { id: "claude-sdk", name: "Claude", provider: "anthropic", available: true, busy: false, capabilities: ["ask", "agent", "plan"] },
      ];
    }
  } finally {
    agentSelectorLoading.value = false;
  }
}

/**
 * Switch the active agent via API.
 * @param {string} agentId
 */
async function switchAgent(agentId) {
  const previous = activeAgent.value;
  activeAgent.value = agentId; // optimistic
  try {
    await apiFetch("/api/agents/switch", {
      method: "POST",
      body: JSON.stringify({ agent: agentId }),
    });
  } catch (err) {
    console.warn("[agent-selector] Failed to switch agent:", err);
    activeAgent.value = previous; // rollback
  }
}

/**
 * Set the agent interaction mode via API.
 * @param {"ask"|"agent"|"plan"} mode
 */
async function setAgentMode(mode) {
  const previous = agentMode.value;
  agentMode.value = mode; // optimistic
  try {
    await apiFetch("/api/agents/mode", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  } catch (err) {
    console.warn("[agent-selector] Failed to set mode:", err);
    agentMode.value = previous; // rollback
  }
}

/* ═══════════════════════════════════════════════
 *  AgentModeSelector
 *  Compact pill group: Ask | Agent | Plan
 * ═══════════════════════════════════════════════ */

export function AgentModeSelector() {
  const currentMode = agentMode.value;

  const handleSelect = useCallback((mode) => {
    if (mode === agentMode.value) return;
    haptic("light");
    setAgentMode(mode);
  }, []);

  return html`
    <div class="agent-mode-group" role="radiogroup" aria-label="Agent mode">
      ${MODES.map((m) => html`
        <button
          key=${m.id}
          class="agent-mode-pill ${currentMode === m.id ? "active" : ""}"
          role="radio"
          aria-checked=${currentMode === m.id}
          title=${m.description}
          onClick=${() => handleSelect(m.id)}
        >
          <span class="mode-icon">${m.icon}</span>
          ${m.label}
        </button>
      `)}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  AgentPicker
 *  Dropdown for selecting the AI backend
 * ═══════════════════════════════════════════════ */

export function AgentPicker() {
  const agents = availableAgents.value;
  const current = activeAgent.value;
  const loading = agentSelectorLoading.value;

  const handleChange = useCallback((e) => {
    const agentId = e.target.value;
    if (agentId === activeAgent.value) return;
    haptic("medium");
    switchAgent(agentId);
  }, []);

  const currentIcon = AGENT_ICONS[current] || "⚡";

  return html`
    <div class="agent-picker-wrap">
      <span class="picker-icon" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:13px;pointer-events:none;z-index:1">${currentIcon}</span>
      <select
        class="agent-picker-native"
        value=${current}
        onChange=${handleChange}
        disabled=${loading}
        title="Select AI agent"
      >
        ${agents.length === 0 && html`
          <option disabled>${loading ? "Loading…" : "No agents"}</option>
        `}
        ${agents.map((agent) => {
          const statusLabel = agent.busy ? " (busy)" : !agent.available ? " (offline)" : "";
          return html`
            <option key=${agent.id} value=${agent.id}>
              ${agent.name} · ${agent.provider}${statusLabel}
            </option>
          `;
        })}
      </select>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  AgentStatusBadge
 *  Small indicator showing agent runtime state
 * ═══════════════════════════════════════════════ */

export function AgentStatusBadge() {
  const status = agentStatus.value;
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;
  const alive = aliveAgentCount.value;
  const stale = staleAgentCount.value;
  const errors = totalErrorCount.value;

  return html`
    <div class="agent-status-badge" title=${cfg.label}>
      <span
        class="agent-status-dot ${cfg.pulse ? "pulse" : ""}"
        style="background: ${cfg.color}"
      />
      <span class="agent-status-label">${cfg.label}</span>
      ${alive > 0 && html`<span class="agent-count-badge" title="${alive} agent(s) active" style="background:#2ea043;color:#fff;border-radius:8px;padding:0 5px;font-size:10px;margin-left:4px;">${alive}</span>`}
      ${stale > 0 && html`<span class="agent-count-badge" title="${stale} agent(s) stale" style="background:#d29922;color:#fff;border-radius:8px;padding:0 5px;font-size:10px;margin-left:2px;">⚠${stale}</span>`}
      ${errors > 0 && html`<span class="agent-count-badge" title="${errors} error(s)" style="background:#f85149;color:#fff;border-radius:8px;padding:0 5px;font-size:10px;margin-left:2px;">✕${errors}</span>`}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  ChatInputToolbar
 *  Combines all selectors into a single row
 * ═══════════════════════════════════════════════ */

function YoloToggle() {
  const isYolo = yoloMode.value;

  const toggle = useCallback(() => {
    const next = !yoloMode.peek();
    yoloMode.value = next;
    try { localStorage.setItem("ve-yolo-mode", String(next)); } catch {}
    haptic(next ? "medium" : "light");
  }, []);

  return html`
    <button
      class="yolo-toggle ${isYolo ? 'active' : ''}"
      onClick=${toggle}
      title=${isYolo
        ? 'Yolo ON — agent will auto-approve actions (disable to require confirmations)'
        : 'Enable Yolo mode — agent will skip confirmation prompts'}
      aria-pressed=${isYolo}
    >
      <span class="yolo-checkbox" aria-hidden="true"></span>
      <span class="yolo-icon">⚡</span>
      Yolo
    </button>
  `;
}

export function ChatInputToolbar() {
  // Inject styles on first mount
  useEffect(() => {
    injectAgentSelectorStyles();
  }, []);

  // Load agents on mount — but only if not already loaded or loading.
  // ChatTab already calls loadAvailableAgents() so this is a fallback.
  useEffect(() => {
    if (availableAgents.value.length === 0 && !agentSelectorLoading.value) {
      loadAvailableAgents();
    }
  }, []);

  return html`
    <div class="chat-input-toolbar">
      <${AgentPicker} />
      <${AgentModeSelector} />
      <${YoloToggle} />
      <div class="chat-input-toolbar-spacer" />
      <${AgentStatusBadge} />
    </div>
  `;
}
