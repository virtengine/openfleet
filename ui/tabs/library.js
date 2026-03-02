/* ─────────────────────────────────────────────────────────────
 *  Tab: Library — Prompt, Agent Profile & Skill Manager
 *  View, search, create, edit, and delete library resources
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import {
  showToast,
  refreshTab,
  setPendingChange,
  clearPendingChange,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { formatRelative, countChangedFields } from "../modules/utils.js";
import {
  Card,
  Badge,
  EmptyState,
  Modal,
  ConfirmDialog,
  Spinner,
  ListItem,
  SaveDiscardBar,
} from "../components/shared.js";
import { SearchInput, SegmentedControl, Toggle } from "../components/forms.js";

/* ═══════════════════════════════════════════════════════════════
 *  Styles
 * ═══════════════════════════════════════════════════════════════ */

const LIBRARY_STYLES = `
/* ── Library Tab ────────────────────────────────────── */
.library-root { padding: 12px; max-width: none; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.library-root .card { margin-bottom: 0; }
.library-header { display: flex; align-items: center; gap: 12px; margin: 0; flex-wrap: wrap; }
.library-header h2 { margin: 0; font-size: 1.2em; flex: 1; min-width: 120px; }

.library-toolbar { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; margin: 0; }
.library-toolbar .search-wrap { flex: 1; min-width: 200px; }

.library-type-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.library-type-pill { padding: 4px 12px; border-radius: 14px; border: 1px solid var(--border, #333);
  background: transparent; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 0.85em;
  transition: all 0.15s; white-space: nowrap; }
.library-type-pill:hover { border-color: var(--accent, #58a6ff); color: var(--text-primary, #eee); }
.library-type-pill.active { background: var(--accent, #58a6ff); color: #fff; border-color: var(--accent, #58a6ff); }

.library-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.library-card { background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #333);
  border-radius: 12px; padding: 16px; padding-right: 96px; cursor: pointer; transition: all 0.15s; position: relative; }
.library-card:hover { border-color: var(--accent, #58a6ff); transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3); }

.library-card-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.library-card-icon { font-size: 1.4em; flex-shrink: 0; width: 32px; text-align: center; }
.library-card-icon svg { width: 20px; height: 20px; vertical-align: middle; }
.library-card-header > div { min-width: 0; flex: 1; }
.library-card-title { font-weight: 600; font-size: 0.95em; color: var(--text-primary, #eee);
  overflow-wrap: anywhere; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.library-card-desc { font-size: 0.82em; color: var(--text-secondary, #aaa); margin-bottom: 8px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.library-card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.library-card-tag { font-size: 0.75em; padding: 2px 8px; border-radius: 10px;
  background: var(--tag-bg, rgba(88,166,255,0.15)); color: var(--accent, #58a6ff); }
.library-card-scope { font-size: 0.72em; color: var(--text-tertiary, #777); margin-left: auto; }

.library-card-type { position: absolute; top: 8px; right: 8px; }

/* ─ Detail / Editor Modal ─ */
.library-editor { display: flex; flex-direction: column; gap: 14px; }
.library-editor label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85em;
  color: var(--text-secondary, #aaa); }
.library-editor input, .library-editor select, .library-editor textarea {
  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, #333);
  background: var(--bg-input, #0d1117); color: var(--text-primary, #eee); font-size: 0.9em; }
.library-editor textarea { min-height: 160px; font-family: 'Fira Code', monospace; font-size: 0.82em;
  resize: vertical; }
.library-editor .tag-input-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.library-editor .tag-input-row input { flex: 1; min-width: 100px; }

.library-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.library-actions button { padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
  font-size: 0.9em; font-weight: 500; }
.library-actions .btn-primary { background: var(--accent, #58a6ff); color: #fff; }
.library-actions .btn-primary:hover { filter: brightness(1.1); }
.library-actions .btn-danger { background: #d73a49; color: #fff; }
.library-actions .btn-danger:hover { filter: brightness(1.1); }
.library-actions .btn-ghost { background: transparent; color: var(--text-secondary, #aaa);
  border: 1px solid var(--border, #333); }
.library-actions .btn-ghost:hover { border-color: var(--accent, #58a6ff); color: var(--text-primary, #eee); }

/* ─ Scope & Profile sections ─ */
.library-scopes { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.library-scope-chip { font-size: 0.8em; padding: 3px 10px; border-radius: 10px;
  background: rgba(88,166,255,0.1); color: var(--accent, #58a6ff); border: 1px solid transparent; }
.library-scope-chip.git { border-color: rgba(88,166,255,0.25); }
.library-scope-chip.folder { border-color: rgba(255,166,88,0.25); color: #ffa658; background: rgba(255,166,88,0.1); }
.library-scope-chip .count { font-weight: 600; margin-left: 4px; }

.library-profile-match { padding: 12px; background: var(--bg-card, #1a1a2e);
  border-radius: 10px; border: 1px solid var(--accent, #58a6ff); }
.library-profile-match-label { font-size: 0.8em; color: var(--text-secondary, #aaa); margin-bottom: 4px; }
.library-profile-match-name { font-weight: 600; color: var(--text-primary, #eee); }
.library-profile-match-score { font-size: 0.75em; color: var(--accent, #58a6ff); margin-left: 8px; }

/* ─ Stats bar ─ */
.library-stats { display: flex; gap: 16px; margin: 0; flex-wrap: wrap; }
.library-stat { text-align: center; }
.library-stat-val { font-size: 1.6em; font-weight: 700; color: var(--text-primary, #eee); }
.library-stat-lbl { font-size: 0.75em; color: var(--text-secondary, #aaa); text-transform: uppercase; letter-spacing: 0.05em; }

/* ─ Init banner ─ */
.library-init-banner { padding: 16px; border-radius: 12px; background: var(--bg-card, #1a1a2e);
  border: 1px dashed var(--border, #333); text-align: center; margin: 0; }
.library-init-banner p { color: var(--text-secondary, #aaa); margin: 8px 0; font-size: 0.9em; }
.library-init-banner button { padding: 8px 20px; border-radius: 8px; border: none;
  background: var(--accent, #58a6ff); color: #fff; cursor: pointer; font-weight: 600; }

/* ─ Responsive behavior ─ */
@media (min-width: 1000px) {
  .library-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (min-width: 1400px) {
  .library-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}

@media (max-width: 700px) {
  .library-root { padding: 8px; }
  .library-header { gap: 8px; }
  .library-toolbar { gap: 6px; }
  .library-toolbar .search-wrap { flex: 1 1 100%; min-width: 0; }
  .library-grid { grid-template-columns: 1fr; }
  .library-card { padding: 12px; padding-right: 84px; }
  .library-card-scope { margin-left: 0; }
  .library-actions { flex-wrap: wrap; justify-content: stretch; }
  .library-actions button { flex: 1 1 140px; padding: 10px 12px; }
}

@media (max-width: 520px) {
  .library-type-pills { gap: 4px; }
  .library-type-pill { font-size: 0.8em; padding: 4px 10px; }
  .library-stats { gap: 10px; }
  .library-stat { min-width: 64px; }
  .library-stat-val { font-size: 1.3em; }
}

/* ── MCP Marketplace ────────────────────────────────── */
.mcp-section { display: flex; flex-direction: column; gap: 12px; }
.mcp-section-header { display: flex; align-items: center; gap: 8px; }
.mcp-section-header h3 { margin: 0; font-size: 1em; flex: 1; }
.mcp-catalog-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 10px; }
.mcp-card { background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #333);
  border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px;
  transition: border-color 0.15s; }
.mcp-card:hover { border-color: var(--accent, #58a6ff); }
.mcp-card-header { display: flex; align-items: center; gap: 10px; }
.mcp-card-name { font-weight: 600; font-size: 0.92em; color: var(--text-primary, #eee); flex: 1; }
.mcp-card-desc { font-size: 0.8em; color: var(--text-secondary, #aaa); line-height: 1.4; }
.mcp-card-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.mcp-card-tag { font-size: 0.72em; padding: 2px 7px; border-radius: 8px;
  background: rgba(88,166,255,0.1); color: var(--accent, #58a6ff); }
.mcp-card-actions { display: flex; gap: 6px; margin-top: auto; }
.mcp-card-actions button { padding: 5px 14px; border-radius: 7px; border: 1px solid var(--border, #333);
  background: transparent; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 0.82em;
  transition: all 0.15s; }
.mcp-card-actions button:hover { border-color: var(--accent, #58a6ff); color: var(--text-primary, #eee); }
.mcp-card-actions .btn-install { background: var(--accent, #58a6ff); color: #fff; border-color: var(--accent, #58a6ff); }
.mcp-card-actions .btn-install:hover { filter: brightness(1.1); }
.mcp-card-actions .btn-installed { background: rgba(63,185,80,0.15); color: #3fb950; border-color: rgba(63,185,80,0.3); cursor: default; }
.mcp-card-actions .btn-uninstall { color: #d73a49; border-color: rgba(215,58,73,0.3); }
.mcp-card-actions .btn-uninstall:hover { background: rgba(215,58,73,0.1); }

.mcp-env-editor { display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
  padding: 10px; background: var(--bg-input, #0d1117); border-radius: 8px; border: 1px solid var(--border, #333); }
.mcp-env-row { display: flex; gap: 6px; align-items: center; }
.mcp-env-key { font-size: 0.78em; font-family: monospace; color: var(--accent, #58a6ff); min-width: 140px; }
.mcp-env-input { flex: 1; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border, #333);
  background: var(--bg-card, #1a1a2e); color: var(--text-primary, #eee); font-size: 0.82em; font-family: monospace; }

/* Custom MCP form */
.mcp-custom-form { display: flex; flex-direction: column; gap: 10px; padding: 14px;
  background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #333); border-radius: 10px; }
.mcp-custom-form label { display: flex; flex-direction: column; gap: 3px; font-size: 0.82em;
  color: var(--text-secondary, #aaa); }
.mcp-custom-form input, .mcp-custom-form select { padding: 6px 10px; border-radius: 7px;
  border: 1px solid var(--border, #333); background: var(--bg-input, #0d1117);
  color: var(--text-primary, #eee); font-size: 0.85em; }

/* ── Tool Configuration ────────────────────────────── */
.tool-config-section { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.tool-config-header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #333); }
.tool-config-header h4 { margin: 0; font-size: 0.92em; flex: 1; color: var(--text-primary, #eee); }
.tool-config-group { display: flex; flex-direction: column; gap: 2px; }
.tool-config-group-label { font-size: 0.78em; color: var(--text-secondary, #aaa); text-transform: uppercase;
  letter-spacing: 0.04em; margin: 8px 0 4px; font-weight: 600; }
.tool-config-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 8px; transition: background 0.1s; }
.tool-config-item:hover { background: rgba(255,255,255,0.03); }
.tool-config-item-icon { font-size: 1.1em; width: 24px; text-align: center; flex-shrink: 0; }
.tool-config-item-icon svg { width: 16px; height: 16px; vertical-align: middle; }
.tool-config-item-info { flex: 1; min-width: 0; }
.tool-config-item-name { font-size: 0.88em; font-weight: 500; color: var(--text-primary, #eee); }
.tool-config-item-desc { font-size: 0.76em; color: var(--text-secondary, #aaa); }
.tool-config-toggle { flex-shrink: 0; }

/* ── Agent Detail with Tools ──────────────────────── */
.agent-tools-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border, #333); }
.agent-tools-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.agent-tools-tab { padding: 5px 14px; border-radius: 14px; border: 1px solid var(--border, #333);
  background: transparent; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 0.82em;
  transition: all 0.15s; }
.agent-tools-tab:hover { border-color: var(--accent, #58a6ff); }
.agent-tools-tab.active { background: var(--accent, #58a6ff); color: #fff; border-color: var(--accent, #58a6ff); }

@media (min-width: 1000px) {
  .mcp-catalog-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = LIBRARY_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

/* ═══════════════════════════════════════════════════════════════
 *  State signals
 * ═══════════════════════════════════════════════════════════════ */

const entries = signal([]);
const scopes = signal([]);
const isLoading = signal(false);
const initialized = signal(false);
const filterType = signal("all"); // "all" | "prompt" | "agent" | "skill" | "mcp"
const searchQuery = signal("");
const mcpCatalog = signal([]);
const mcpInstalled = signal([]);
const mcpCatalogLoaded = signal(false);

/* ═══════════════════════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function fetchEntries(type) {
  const params = new URLSearchParams();
  if (type && type !== "all") params.set("type", type);
  const q = searchQuery.value?.trim();
  if (q) params.set("search", q);
  const qs = params.toString();
  const res = await apiFetch(`/api/library${qs ? `?${qs}` : ""}`);
  return res?.data || [];
}

async function fetchEntry(id) {
  const res = await apiFetch(`/api/library/entry?id=${encodeURIComponent(id)}`);
  return res?.data || null;
}

async function saveEntry(data) {
  const res = await apiFetch("/api/library/entry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res;
}

async function removeEntry(id, deleteFile = false) {
  return apiFetch("/api/library/entry", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, deleteFile }),
  });
}

async function fetchScopes() {
  const res = await apiFetch("/api/library/scopes");
  return res?.data || [];
}

async function doInit() {
  const res = await apiFetch("/api/library/init", { method: "POST" });
  return res;
}

async function doRebuild() {
  return apiFetch("/api/library/rebuild", { method: "POST" });
}

async function testProfileMatch(title) {
  const res = await apiFetch(`/api/library/match-profile?title=${encodeURIComponent(title)}`);
  return res?.data || null;
}

/* ── MCP API Helpers ─ */

async function fetchMcpCatalog() {
  const res = await apiFetch("/api/mcp/catalog");
  return res?.data || [];
}

async function fetchMcpInstalled() {
  const res = await apiFetch("/api/mcp/installed");
  return res?.data || [];
}

async function installMcp(idOrDef, envOverrides) {
  const body = typeof idOrDef === "string"
    ? { id: idOrDef, envOverrides }
    : { serverDef: idOrDef, envOverrides };
  return apiFetch("/api/mcp/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function uninstallMcp(id) {
  return apiFetch("/api/mcp/uninstall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

async function configureMcpEnv(id, env) {
  return apiFetch("/api/mcp/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, env }),
  });
}

/* ── Agent Tool Config API Helpers ─ */

async function fetchAvailableTools() {
  const res = await apiFetch("/api/agent-tools/available");
  return res?.data || { builtinTools: [], mcpServers: [] };
}

async function fetchAgentToolConfig(agentId) {
  const res = await apiFetch(`/api/agent-tools/config?agentId=${encodeURIComponent(agentId)}`);
  return res?.data || { builtinTools: [], mcpServers: [] };
}

async function saveAgentToolConfig(agentId, config) {
  return apiFetch("/api/agent-tools/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, ...config }),
  });
}

async function fetchBuiltinToolDefaults() {
  const res = await apiFetch("/api/agent-tools/defaults");
  return res?.data?.builtinTools || [];
}

/* ═══════════════════════════════════════════════════════════════
 *  Icons per type
 * ═══════════════════════════════════════════════════════════════ */

const TYPE_ICONS = { prompt: ":edit:", agent: ":bot:", skill: ":cpu:", mcp: ":plug:" };
const TYPE_LABELS = { prompt: "Prompt", agent: "Agent Profile", skill: "Skill", mcp: "MCP Server" };
const TYPE_COLORS = { prompt: "#58a6ff", agent: "#af7bff", skill: "#3fb950", mcp: "#f59e0b" };

/* ═══════════════════════════════════════════════════════════════
 *  Sub-components
 * ═══════════════════════════════════════════════════════════════ */

function LibraryStats() {
  const all = entries.value;
  const counts = { prompt: 0, agent: 0, skill: 0, mcp: 0 };
  for (const e of all) { if (counts[e.type] !== undefined) counts[e.type]++; }
  return html`
    <div class="library-stats">
      <div class="library-stat">
        <div class="library-stat-val">${all.length}</div>
        <div class="library-stat-lbl">Total</div>
      </div>
      <div class="library-stat">
        <div class="library-stat-val" style="color: ${TYPE_COLORS.prompt}">${counts.prompt}</div>
        <div class="library-stat-lbl">${iconText(`${TYPE_ICONS.prompt} Prompts`)}</div>
      </div>
      <div class="library-stat">
        <div class="library-stat-val" style="color: ${TYPE_COLORS.agent}">${counts.agent}</div>
        <div class="library-stat-lbl">${iconText(`${TYPE_ICONS.agent} Agents`)}</div>
      </div>
      <div class="library-stat">
        <div class="library-stat-val" style="color: ${TYPE_COLORS.skill}">${counts.skill}</div>
        <div class="library-stat-lbl">${iconText(`${TYPE_ICONS.skill} Skills`)}</div>
      </div>
      <div class="library-stat">
        <div class="library-stat-val" style="color: ${TYPE_COLORS.mcp}">${counts.mcp}</div>
        <div class="library-stat-lbl">${iconText(`${TYPE_ICONS.mcp} MCP`)}</div>
      </div>
    </div>
  `;
}

function TypePills() {
  const types = [
    { id: "all", label: "All" },
    { id: "prompt", label: `${TYPE_ICONS.prompt} Prompts` },
    { id: "agent", label: `${TYPE_ICONS.agent} Agents` },
    { id: "skill", label: `${TYPE_ICONS.skill} Skills` },
    { id: "mcp", label: `${TYPE_ICONS.mcp} MCP Servers` },
  ];
  return html`
    <div class="library-type-pills">
      ${types.map((t) => html`
        <button key=${t.id}
          class=${`library-type-pill ${filterType.value === t.id ? "active" : ""}`}
          onClick=${() => { filterType.value = t.id; }}>
          ${iconText(t.label)}
        </button>
      `)}
    </div>
  `;
}

function LibraryCard({ entry, onSelect }) {
  const icon = TYPE_ICONS[entry.type] || ":file:";
  const typeLabel = TYPE_LABELS[entry.type] || entry.type;
  const typeColor = TYPE_COLORS[entry.type] || "#aaa";
  return html`
    <div class="library-card" onClick=${() => onSelect(entry)}>
      <div class="library-card-type">
        <${Badge} text=${typeLabel} status="info"
          className=${`badge-${entry.type}`}
          style=${{ "--badge-color": typeColor }} />
      </div>
      <div class="library-card-header">
        <span class="library-card-icon">${resolveIcon(icon) || icon}</span>
        <div>
          <div class="library-card-title">${entry.name}</div>
        </div>
      </div>
      ${entry.description && html`
        <div class="library-card-desc">${entry.description}</div>
      `}
      <div class="library-card-meta">
        ${(entry.tags || []).slice(0, 5).map((tag) => html`
          <span class="library-card-tag" key=${tag}>${tag}</span>
        `)}
        ${entry.scope && entry.scope !== "global" && html`
          <span class="library-card-scope">${iconText(`:pin: ${entry.scope}`)}</span>
        `}
      </div>
    </div>
  `;
}

/* ─ Entry Editor / Detail Modal ──────────────────────────── */

function EntryEditor({ entry, onClose, onSaved, onDeleted }) {
  const isNew = !entry?.id;
  const initialFormSnapshot = {
    id: entry?.id || "",
    type: entry?.type || "prompt",
    name: entry?.name || "",
    description: entry?.description || "",
    tags: (entry?.tags || []).join(", "),
    scope: entry?.scope || "global",
    content: "",
  };
  const [form, setForm] = useState(initialFormSnapshot);
  const [baseline, setBaseline] = useState(initialFormSnapshot);
  const [loading, setLoading] = useState(false);
  const [loadingContent, setLoadingContent] = useState(!isNew && !!entry?.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingKey = useMemo(
    () => `modal:library-entry:${entry?.id || "new"}`,
    [entry?.id],
  );

  useEffect(() => {
    const next = {
      id: entry?.id || "",
      type: entry?.type || "prompt",
      name: entry?.name || "",
      description: entry?.description || "",
      tags: (entry?.tags || []).join(", "),
      scope: entry?.scope || "global",
      content: "",
    };
    setForm(next);
    setBaseline(next);
    setLoadingContent(!isNew && !!entry?.id);
  }, [entry?.id]);

  // Load content for existing entries
  useEffect(() => {
    if (isNew || !entry?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await fetchEntry(entry.id);
        if (cancelled) return;
        let contentStr = detail?.content ?? "";
        if (typeof contentStr === "object") contentStr = JSON.stringify(contentStr, null, 2);
        setForm((f) => {
          const next = { ...f, content: contentStr };
          setBaseline(next);
          return next;
        });
      } catch { /* ignore */ }
      setLoadingContent(false);
    })();
    return () => { cancelled = true; };
  }, [entry?.id]);

  const updateField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const changeCount = useMemo(
    () => countChangedFields(baseline, form),
    [baseline, form],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved, pendingKey]);

  const resetToBaseline = useCallback(() => {
    setForm(baseline);
    showToast("Changes discarded", "info");
  }, [baseline]);

  const handleSave = useCallback(async ({ closeAfterSave = true } = {}) => {
    if (!form.name.trim()) {
      showToast("Name is required", "error");
      return false;
    }
    setLoading(true);
    try {
      const tags = form.tags.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      let content = form.content;
      if (form.type === "agent") {
        try { content = JSON.parse(content); } catch { /* keep as string if invalid JSON */ }
      }
      const res = await saveEntry({
        id: form.id || undefined,
        type: form.type,
        name: form.name.trim(),
        description: form.description.trim(),
        tags,
        scope: form.scope,
        content,
      });
      if (res?.ok) {
        showToast(`${TYPE_LABELS[form.type] || "Entry"} saved`, "success");
        const nextBaseline = { ...form };
        setBaseline(nextBaseline);
        if (closeAfterSave) {
          onSaved?.();
          return { closed: true };
        }
        return true;
      } else {
        showToast(res?.error || "Save failed", "error");
        return false;
      }
    } catch (err) {
      showToast(err.message, "error");
      return false;
    } finally {
      setLoading(false);
    }
  }, [form, onSaved]);

  const handleDelete = useCallback(async () => {
    setLoading(true);
    try {
      const res = await removeEntry(entry.id, true);
      if (res?.ok) {
        showToast("Deleted", "success");
        onDeleted?.();
      } else {
        showToast(res?.error || "Delete failed", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
    setLoading(false);
  }, [entry?.id, onDeleted]);

  const contentPlaceholder = form.type === "prompt"
    ? "# Prompt Title\n\nYour prompt content here...\n\nUse {{VARIABLE_NAME}} for template variables."
    : form.type === "agent"
      ? JSON.stringify({
          name: "My Agent",
          description: "Agent description",
          titlePatterns: ["\\\\(scope\\\\)"],
          scopes: ["scope"],
          sdk: null,
          model: null,
          promptOverride: null,
          skills: [],
          tags: [],
        }, null, 2)
      : "# Skill Title\n\n## Purpose\nDescribe what this skill teaches agents.\n\n## Instructions\n...";

  return html`
    <${Modal}
      title=${isNew ? "New Resource" : `Edit: ${entry.name}`}
      onClose=${onClose}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSave({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        resetToBaseline();
        return true;
      }}
      activeOperationLabel=${loading ? "Save/Delete request is still running" : ""}
    >
      <div class="library-editor">
        ${isNew && html`
          <label>
            Type
            <select value=${form.type} onChange=${updateField("type")}>
              <option value="prompt">Prompt</option>
              <option value="agent">Agent Profile</option>
              <option value="skill">Skill</option>
              <option value="mcp">MCP Server</option>
            </select>
          </label>
        `}
        <label>
          Name
          <input type="text" value=${form.name} onInput=${updateField("name")}
            placeholder="e.g. Task Executor, UI Agent, Background Tasks" />
        </label>
        <label>
          Description
          <input type="text" value=${form.description} onInput=${updateField("description")}
            placeholder="Brief one-line summary" />
        </label>
        <label>
          Tags (comma-separated)
          <input type="text" value=${form.tags} onInput=${updateField("tags")}
            placeholder="e.g. frontend, ui, react" />
        </label>
        <label>
          Scope
          <select value=${form.scope} onChange=${updateField("scope")}>
            <option value="global">Global</option>
            <option value="workspace">Workspace</option>
          </select>
        </label>
        <label>
          Content
          ${loadingContent
            ? html`<div style="text-align:center;padding:20px;"><${Spinner} /> Loading content...</div>`
            : html`<textarea value=${form.content} onInput=${updateField("content")}
                placeholder=${contentPlaceholder}
                rows="12" />`
          }
        </label>
        <div style="font-size:0.78em;color:var(--text-tertiary,#666);margin-top:-8px;">
          ${form.type === "prompt" ? "Use {{VARIABLE_NAME}} for template variables. Reference in workflows as {{prompt:name}}."
            : form.type === "agent" ? "JSON format. Referenced in workflows as {{agent:name}}."
            : form.type === "mcp" ? "MCP server configuration. Managed via the MCP Servers panel."
            : "Markdown format. Referenced in workflows as {{skill:name}}."}
        </div>

        ${/* ── Agent Tool Configuration Section ── */
          !isNew && form.type === "agent" && entry?.id && html`
            <${AgentToolConfigurator} agentId=${entry.id} agentName=${entry.name || form.name} />
          `
        }

        <div class="library-actions">
          ${!isNew && html`
            <button class="btn-danger" onClick=${() => setConfirmDelete(true)} disabled=${loading}>
              Delete
            </button>
          `}
          <div style="flex:1" />
          <button class="btn-ghost" onClick=${onClose}>Cancel</button>
          <button
            class="btn-primary"
            onClick=${() => {
              void handleSave({ closeAfterSave: true });
            }}
            disabled=${loading}
          >
            ${loading ? html`<${Spinner} size=${14} />` : (isNew ? "Create" : "Save")}
          </button>
        </div>
        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${`You have unsaved changes (${changeCount})`}
          saveLabel=${isNew ? "Create" : "Save Changes"}
          discardLabel="Discard"
          onSave=${() => {
            void handleSave({ closeAfterSave: false });
          }}
          onDiscard=${resetToBaseline}
          saving=${loading}
        />
      </div>
      ${confirmDelete && html`
        <${ConfirmDialog}
          title="Delete resource?"
          message=${`This will delete "${entry.name}" from the library and remove the file from disk.`}
          onConfirm=${handleDelete}
          onCancel=${() => setConfirmDelete(false)} />
      `}
    <//>
  `;
}

/* ─ Agent Tool Configurator ─────────────────────────────── */

function AgentToolConfigurator({ agentId, agentName }) {
  const [toolsTab, setToolsTab] = useState("builtin"); // "builtin" | "mcp"
  const [tools, setTools] = useState({ builtinTools: [], mcpServers: [] });
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [effective, inst] = await Promise.all([
        fetchAgentToolConfig(agentId),
        fetchMcpInstalled(),
      ]);
      setTools(effective);
      setInstalled(inst);
    } catch (err) {
      showToast("Failed to load tool config: " + err.message, "error");
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { loadConfig(); }, [agentId]);

  const toggleBuiltinTool = useCallback(async (toolId, enabled) => {
    const current = tools.builtinTools || [];
    const disabledList = current.filter((t) => !t.enabled).map((t) => t.id);
    const newDisabled = enabled
      ? disabledList.filter((id) => id !== toolId)
      : [...disabledList, toolId];
    setSaving(true);
    try {
      await saveAgentToolConfig(agentId, { disabledBuiltinTools: newDisabled });
      setTools((prev) => ({
        ...prev,
        builtinTools: prev.builtinTools.map((t) =>
          t.id === toolId ? { ...t, enabled } : t
        ),
      }));
    } catch (err) {
      showToast("Failed to save: " + err.message, "error");
    }
    setSaving(false);
  }, [agentId, tools]);

  const toggleMcpServer = useCallback(async (serverId, enabled) => {
    const currentMcp = tools.mcpServers || [];
    const newMcp = enabled
      ? [...new Set([...currentMcp, serverId])]
      : currentMcp.filter((id) => id !== serverId);
    setSaving(true);
    try {
      await saveAgentToolConfig(agentId, { enabledMcpServers: newMcp });
      setTools((prev) => ({ ...prev, mcpServers: newMcp }));
    } catch (err) {
      showToast("Failed to save: " + err.message, "error");
    }
    setSaving(false);
  }, [agentId, tools]);

  const enabledMcpSet = new Set(tools.mcpServers || []);

  if (loading) {
    return html`<div class="agent-tools-section">
      <div style="text-align:center;padding:16px;"><${Spinner} size=${16} /> Loading tools...</div>
    </div>`;
  }

  return html`
    <div class="agent-tools-section">
      <div class="tool-config-header">
        <h4>${iconText(":settings: Tools & MCP Servers")}</h4>
        ${saving && html`<${Spinner} size=${12} />`}
      </div>

      <div class="agent-tools-tabs">
        <button class=${`agent-tools-tab ${toolsTab === "builtin" ? "active" : ""}`}
          onClick=${() => setToolsTab("builtin")}>
          ${iconText(":cpu: Built-in Tools")} (${(tools.builtinTools || []).filter((t) => t.enabled).length}/${(tools.builtinTools || []).length})
        </button>
        <button class=${`agent-tools-tab ${toolsTab === "mcp" ? "active" : ""}`}
          onClick=${() => setToolsTab("mcp")}>
          ${iconText(":plug: MCP Servers")} (${enabledMcpSet.size}/${installed.length})
        </button>
      </div>

      ${toolsTab === "builtin" && html`
        <div class="tool-config-group">
          ${(tools.builtinTools || []).map((tool) => html`
            <div class="tool-config-item" key=${tool.id}>
              <span class="tool-config-item-icon">${resolveIcon(tool.icon) || iconText(tool.icon || ":cpu:")}</span>
              <div class="tool-config-item-info">
                <div class="tool-config-item-name">${tool.name}</div>
                <div class="tool-config-item-desc">${tool.description}</div>
              </div>
              <div class="tool-config-toggle">
                <${Toggle}
                  checked=${tool.enabled}
                  onChange=${(val) => toggleBuiltinTool(tool.id, val)}
                />
              </div>
            </div>
          `)}
        </div>
      `}

      ${toolsTab === "mcp" && html`
        <div class="tool-config-group">
          ${installed.length === 0 && html`
            <div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:0.85em;">
              No MCP servers installed. Use the MCP Servers tab to install from the marketplace.
            </div>
          `}
          ${installed.map((srv) => html`
            <div class="tool-config-item" key=${srv.id}>
              <span class="tool-config-item-icon">${resolveIcon(":plug:") || iconText(":plug:")}</span>
              <div class="tool-config-item-info">
                <div class="tool-config-item-name">${srv.name}</div>
                <div class="tool-config-item-desc">${srv.description || `Transport: ${srv.meta?.transport || "stdio"}`}</div>
              </div>
              <div class="tool-config-toggle">
                <${Toggle}
                  checked=${enabledMcpSet.has(srv.id)}
                  onChange=${(val) => toggleMcpServer(srv.id, val)}
                />
              </div>
            </div>
          `)}
        </div>
      `}
    </div>
  `;
}

/* ─ MCP Marketplace / Catalog ─────────────────────────────── */

function McpMarketplace({ onInstalled }) {
  const [catalog, setCatalog] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(null);
  const [uninstalling, setUninstalling] = useState(null);
  const [configuring, setConfiguring] = useState(null);
  const [envEdits, setEnvEdits] = useState({});
  const [showCustom, setShowCustom] = useState(false);
  const [marketplaceSearch, setMarketplaceSearch] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, inst] = await Promise.all([
        fetchMcpCatalog(),
        fetchMcpInstalled(),
      ]);
      setCatalog(cat);
      setInstalled(inst);
      mcpCatalog.value = cat;
      mcpInstalled.value = inst;
    } catch (err) {
      showToast("Failed to load MCP data: " + err.message, "error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, []);

  const installedIds = new Set(installed.map((s) => s.id));

  const handleInstall = useCallback(async (catalogId) => {
    setInstalling(catalogId);
    try {
      const envVars = envEdits[catalogId] || {};
      const res = await installMcp(catalogId, envVars);
      if (res?.ok) {
        showToast(`Installed ${catalogId}`, "success");
        await loadData();
        onInstalled?.();
      } else {
        showToast(res?.error || "Install failed", "error");
      }
    } catch (err) {
      showToast("Install failed: " + err.message, "error");
    }
    setInstalling(null);
  }, [envEdits, loadData, onInstalled]);

  const handleUninstall = useCallback(async (id) => {
    setUninstalling(id);
    try {
      const res = await uninstallMcp(id);
      if (res?.ok) {
        showToast(`Uninstalled ${id}`, "success");
        await loadData();
        onInstalled?.();
      } else {
        showToast(res?.error || "Uninstall failed", "error");
      }
    } catch (err) {
      showToast("Uninstall failed: " + err.message, "error");
    }
    setUninstalling(null);
  }, [loadData, onInstalled]);

  const handleConfigure = useCallback(async (id) => {
    const env = envEdits[id] || {};
    try {
      const res = await configureMcpEnv(id, env);
      if (res?.ok) {
        showToast(`Updated ${id} configuration`, "success");
        setConfiguring(null);
      } else {
        showToast(res?.error || "Update failed", "error");
      }
    } catch (err) {
      showToast("Update failed: " + err.message, "error");
    }
  }, [envEdits]);

  const handleCustomInstall = useCallback(async (def) => {
    setInstalling("custom");
    try {
      const res = await installMcp(def);
      if (res?.ok) {
        showToast(`Installed custom MCP server: ${def.name}`, "success");
        setShowCustom(false);
        await loadData();
        onInstalled?.();
      } else {
        showToast(res?.error || "Install failed", "error");
      }
    } catch (err) {
      showToast("Install failed: " + err.message, "error");
    }
    setInstalling(null);
  }, [loadData, onInstalled]);

  const updateEnv = useCallback((serverId, key, value) => {
    setEnvEdits((prev) => ({
      ...prev,
      [serverId]: { ...(prev[serverId] || {}), [key]: value },
    }));
  }, []);

  const filteredCatalog = useMemo(() => {
    if (!marketplaceSearch.trim()) return catalog;
    const q = marketplaceSearch.toLowerCase();
    return catalog.filter(
      (s) => s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [catalog, marketplaceSearch]);

  if (loading) {
    return html`<div style="text-align:center;padding:40px;"><${Spinner} /> Loading MCP marketplace...</div>`;
  }

  return html`
    <div class="mcp-section">
      <!-- Installed section -->
      ${installed.length > 0 && html`
        <div class="mcp-section-header">
          <h3>${iconText(":check: Installed")} (${installed.length})</h3>
        </div>
        <div class="mcp-catalog-grid">
          ${installed.map((srv) => html`
            <div class="mcp-card" key=${srv.id}>
              <div class="mcp-card-header">
                <span class="mcp-card-name">${srv.name}</span>
                <${Badge} text="Installed" status="success" />
              </div>
              <div class="mcp-card-desc">${srv.description}</div>
              <div class="mcp-card-tags">
                ${(srv.tags || []).map((t) => html`<span class="mcp-card-tag" key=${t}>${t}</span>`)}
              </div>
              <div class="mcp-card-actions">
                <button class="btn-uninstall"
                  onClick=${() => handleUninstall(srv.id)}
                  disabled=${uninstalling === srv.id}>
                  ${uninstalling === srv.id ? html`<${Spinner} size=${12} />` : "Uninstall"}
                </button>
                <button onClick=${() => setConfiguring(configuring === srv.id ? null : srv.id)}>
                  ${iconText(":settings: Configure")}
                </button>
              </div>
              ${configuring === srv.id && html`
                <div class="mcp-env-editor">
                  <div style="font-size:0.78em;color:var(--text-secondary);margin-bottom:4px;">
                    Environment Variables
                  </div>
                  ${Object.entries(srv.meta?.env || {}).map(([key, val]) => html`
                    <div class="mcp-env-row" key=${key}>
                      <span class="mcp-env-key">${key}</span>
                      <input class="mcp-env-input"
                        type=${key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? "password" : "text"}
                        value=${envEdits[srv.id]?.[key] ?? val}
                        placeholder="Enter value..."
                        onInput=${(e) => updateEnv(srv.id, key, e.target.value)} />
                    </div>
                  `)}
                  ${Object.keys(srv.meta?.env || {}).length === 0 && html`
                    <div style="font-size:0.82em;color:var(--text-tertiary,#666);">No environment variables required.</div>
                  `}
                  <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px;">
                    <button class="library-type-pill" onClick=${() => setConfiguring(null)}>Cancel</button>
                    <button class="library-type-pill active" onClick=${() => handleConfigure(srv.id)}>
                      ${iconText(":check: Save")}
                    </button>
                  </div>
                </div>
              `}
            </div>
          `)}
        </div>
      `}

      <!-- Marketplace Catalog -->
      <div class="mcp-section-header">
        <h3>${iconText(":shopping: MCP Marketplace")}</h3>
        <button class="library-type-pill" onClick=${() => setShowCustom(!showCustom)}>
          ${iconText("➕ Custom Server")}
        </button>
      </div>

      <div style="margin-bottom:8px;">
        <${SearchInput}
          value=${marketplaceSearch}
          onChange=${setMarketplaceSearch}
          placeholder="Search marketplace (GitHub, Playwright, Exa, etc.)..." />
      </div>

      ${showCustom && html`
        <${McpCustomInstallForm} onInstall=${handleCustomInstall} installing=${installing === "custom"} />
      `}

      <div class="mcp-catalog-grid">
        ${filteredCatalog.map((srv) => {
          const isInstalled = installedIds.has(srv.id);
          const hasEnv = srv.env && Object.keys(srv.env).length > 0;
          const isInstalling = installing === srv.id;
          return html`
            <div class="mcp-card" key=${srv.id}>
              <div class="mcp-card-header">
                <span class="mcp-card-name">${srv.name}</span>
                ${isInstalled && html`<${Badge} text="Installed" status="success" />`}
              </div>
              <div class="mcp-card-desc">${srv.description}</div>
              <div class="mcp-card-tags">
                ${(srv.tags || []).map((t) => html`<span class="mcp-card-tag" key=${t}>${t}</span>`)}
                <span class="mcp-card-tag" style="background:rgba(255,255,255,0.05);color:var(--text-tertiary,#666);">
                  ${srv.transport}
                </span>
              </div>
              ${hasEnv && !isInstalled && html`
                <div class="mcp-env-editor">
                  ${Object.entries(srv.env).map(([key, val]) => html`
                    <div class="mcp-env-row" key=${key}>
                      <span class="mcp-env-key">${key}</span>
                      <input class="mcp-env-input"
                        type=${key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? "password" : "text"}
                        value=${envEdits[srv.id]?.[key] ?? ""}
                        placeholder=${val || "Enter value..."}
                        onInput=${(e) => updateEnv(srv.id, key, e.target.value)} />
                    </div>
                  `)}
                </div>
              `}
              ${srv.homepage && html`
                <div style="font-size:0.75em;">
                  <a href=${srv.homepage} target="_blank" rel="noopener"
                    style="color:var(--accent,#58a6ff);text-decoration:none;">
                    ${iconText(":link: Documentation")}
                  </a>
                </div>
              `}
              <div class="mcp-card-actions">
                ${isInstalled
                  ? html`<button class="btn-installed" disabled>✓ Installed</button>`
                  : html`
                    <button class="btn-install"
                      onClick=${() => handleInstall(srv.id)}
                      disabled=${isInstalling}>
                      ${isInstalling ? html`<${Spinner} size=${12} />` : iconText(":download: Install")}
                    </button>
                  `
                }
              </div>
            </div>
          `;
        })}
      </div>

      ${filteredCatalog.length === 0 && html`
        <div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:0.9em;">
          ${marketplaceSearch ? "No MCP servers match your search." : "No catalog entries available."}
        </div>
      `}
    </div>
  `;
}

/* ─ Custom MCP Install Form ───────────────────────────────── */

function McpCustomInstallForm({ onInstall, installing }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    transport: "stdio",
    command: "npx",
    args: "",
    url: "",
    tags: "",
    envKeys: "",
  });

  const updateField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = useCallback(() => {
    if (!form.name.trim()) {
      showToast("Server name is required", "error");
      return;
    }
    const def = {
      name: form.name.trim(),
      description: form.description.trim(),
      transport: form.transport,
      tags: form.tags.split(/[,\s]+/).filter(Boolean),
    };
    if (form.transport === "stdio") {
      def.command = form.command.trim() || "npx";
      def.args = form.args.split(/\s+/).filter(Boolean);
    } else {
      def.url = form.url.trim();
    }
    // Parse env keys
    if (form.envKeys.trim()) {
      def.env = {};
      for (const key of form.envKeys.split(/[,\s]+/).filter(Boolean)) {
        def.env[key] = "";
      }
    }
    onInstall(def);
  }, [form, onInstall]);

  return html`
    <div class="mcp-custom-form">
      <div style="font-size:0.88em;font-weight:600;color:var(--text-primary);">
        ${iconText("➕ Install Custom MCP Server")}
      </div>
      <label>
        Name *
        <input type="text" value=${form.name} onInput=${updateField("name")}
          placeholder="e.g. My Custom Server" />
      </label>
      <label>
        Description
        <input type="text" value=${form.description} onInput=${updateField("description")}
          placeholder="Brief description" />
      </label>
      <label>
        Transport
        <select value=${form.transport} onChange=${updateField("transport")}>
          <option value="stdio">stdio (command + args)</option>
          <option value="url">URL (HTTP/SSE endpoint)</option>
        </select>
      </label>
      ${form.transport === "stdio" && html`
        <label>
          Command
          <input type="text" value=${form.command} onInput=${updateField("command")}
            placeholder="npx" />
        </label>
        <label>
          Arguments (space-separated)
          <input type="text" value=${form.args} onInput=${updateField("args")}
            placeholder="-y @scope/mcp-server" />
        </label>
      `}
      ${form.transport === "url" && html`
        <label>
          URL
          <input type="text" value=${form.url} onInput=${updateField("url")}
            placeholder="https://example.com/mcp" />
        </label>
      `}
      <label>
        Tags (comma-separated)
        <input type="text" value=${form.tags} onInput=${updateField("tags")}
          placeholder="custom, tools" />
      </label>
      <label>
        Environment Variable Keys (comma-separated, values set after install)
        <input type="text" value=${form.envKeys} onInput=${updateField("envKeys")}
          placeholder="API_KEY, SECRET_TOKEN" />
      </label>
      <div class="library-actions">
        <button class="btn-primary" onClick=${handleSubmit} disabled=${installing}>
          ${installing ? html`<${Spinner} size=${14} />` : iconText(":download: Install")}
        </button>
      </div>
    </div>
  `;
}

/* ─ Scope Detector Panel ─────────────────────────────────── */

function ScopeDetector() {
  const [showing, setShowing] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadScopes = useCallback(async () => {
    if (scopes.value.length && showing) { setShowing(false); return; }
    setLoading(true);
    try {
      const result = await fetchScopes();
      scopes.value = result;
    } catch (err) {
      showToast("Failed to detect scopes: " + err.message, "error");
    }
    setLoading(false);
    setShowing(true);
  }, [showing]);

  return html`
    <div>
      <button class="btn-ghost library-type-pill" onClick=${loadScopes} style="font-size:0.82em;">
        ${loading ? html`<${Spinner} size=${12} />` : iconText(":search: Detect Scopes")}
      </button>
      ${showing && scopes.value.length > 0 && html`
        <div class="library-scopes">
          ${scopes.value.map((s) => html`
            <span key=${s.name}
              class=${`library-scope-chip ${s.source.startsWith("git") ? "git" : "folder"}`}>
              ${s.name}
              ${s.count > 0 && html`<span class="count">(${s.count})</span>`}
            </span>
          `)}
        </div>
      `}
      ${showing && scopes.value.length === 0 && html`
        <div style="font-size:0.82em;color:var(--text-secondary);margin-top:8px;">
          No scopes detected. Add conventional commit scopes to your git history.
        </div>
      `}
    </div>
  `;
}

/* ─ Profile Matcher Panel ─────────────────────────────────── */

function ProfileMatcher() {
  const [title, setTitle] = useState("");
  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(false);

  const doMatch = useCallback(async () => {
    if (!title.trim()) return;
    setLoading(true);
    try {
      const result = await testProfileMatch(title.trim());
      setMatch(result);
    } catch (err) {
      showToast("Match failed: " + err.message, "error");
    }
    setLoading(false);
  }, [title]);

  return html`
    <div style="margin-bottom:12px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" placeholder="Test task title, e.g. feat(portal): add login page"
          value=${title} onInput=${(e) => setTitle(e.target.value)}
          onKeyDown=${(e) => e.key === "Enter" && doMatch()}
          style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--border,#333);
            background:var(--bg-input,#0d1117);color:var(--text-primary,#eee);font-size:0.85em;" />
        <button class="library-type-pill active" onClick=${doMatch} style="font-size:0.82em;" disabled=${loading}>
          ${loading ? html`<${Spinner} size=${12} />` : iconText(":target: Match")}
        </button>
      </div>
      ${match && html`
        <div class="library-profile-match" style="margin-top:8px;">
          <div class="library-profile-match-label">Best match:</div>
          <div>
            <span class="library-profile-match-name">${iconText(`${TYPE_ICONS.agent} ${match.name}`)}</span>
            <span class="library-profile-match-score">score: ${match.score}</span>
          </div>
          ${match.description && html`
            <div style="font-size:0.8em;color:var(--text-secondary);margin-top:4px;">${match.description}</div>
          `}
        </div>
      `}
      ${match === null && title.trim() && !loading && html`
        <div style="font-size:0.82em;color:var(--text-secondary);margin-top:8px;">
          No matching agent profile. Create one to auto-match this task type.
        </div>
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Main Library Tab
 * ═══════════════════════════════════════════════════════════════ */

export function LibraryTab() {
  injectStyles();
  const [editing, setEditing] = useState(null);      // entry being edited, or {} for new
  const [loading, setLoading] = useState(false);

  // Load all entries on mount and type/search changes
  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchEntries(filterType.value);
      entries.value = data;
      initialized.value = data.length > 0;
    } catch (err) {
      showToast("Failed to load library: " + err.message, "error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadEntries(); }, [filterType.value]);

  // Debounced search
  const searchTimer = useRef(null);
  const handleSearch = useCallback((value) => {
    searchQuery.value = value;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(loadEntries, 300);
  }, [loadEntries]);

  const handleInit = useCallback(async () => {
    setLoading(true);
    try {
      const res = await doInit();
      if (res?.ok) {
        showToast(`Library initialized: ${res.data?.entries || 0} entries, ${res.data?.scaffolded || 0} profiles scaffolded`, "success");
        await loadEntries();
      } else {
        showToast(res?.error || "Init failed", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
    setLoading(false);
  }, [loadEntries]);

  const handleRebuild = useCallback(async () => {
    try {
      const res = await doRebuild();
      if (res?.ok) {
        showToast(`Rebuilt: ${res.data?.count || 0} entries (${res.data?.added || 0} added, ${res.data?.removed || 0} removed)`, "success");
        await loadEntries();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  }, [loadEntries]);

  const handleSelect = useCallback((entry) => {
    haptic("light");
    setEditing(entry);
  }, []);

  const handleSaved = useCallback(() => {
    setEditing(null);
    loadEntries();
  }, [loadEntries]);

  const handleDeleted = useCallback(() => {
    setEditing(null);
    loadEntries();
  }, [loadEntries]);

  // Filter entries for display
  const displayed = useMemo(() => {
    let list = entries.value;
    if (filterType.value !== "all") {
      list = list.filter((e) => e.type === filterType.value);
    }
    return list;
  }, [entries.value, filterType.value]);

  return html`
    <div class="library-root">
      <div class="library-header">
        <h2>${iconText(":book: Library")}</h2>
        <button class="library-type-pill" onClick=${handleRebuild}
          title="Rescan directories and rebuild manifest">
          ${iconText(":refresh: Rebuild")}
        </button>
        <button class="library-type-pill active" onClick=${() => setEditing({})}>
          ${iconText("➕ New")}
        </button>
      </div>

      ${!initialized.value && !loading && html`
        <div class="library-init-banner">
          <p><b>Welcome to the Library!</b></p>
          <p>Initialize to scaffold built-in agent profiles and index existing prompts and skills.</p>
          <button onClick=${handleInit}>${iconText(":rocket: Initialize Library")}</button>
        </div>
      `}

      <${LibraryStats} />

      <div class="library-toolbar">
        <div class="search-wrap">
          <${SearchInput}
            value=${searchQuery.value}
            onChange=${handleSearch}
            placeholder="Search prompts, agents, skills, MCP servers..." />
        </div>
        <${TypePills} />
      </div>

      ${filterType.value !== "mcp" && html`<${ProfileMatcher} />`}
      ${filterType.value !== "mcp" && html`<${ScopeDetector} />`}

      ${/* ── MCP Marketplace View ── */
        filterType.value === "mcp" && html`
          <${McpMarketplace} onInstalled=${loadEntries} />
        `
      }

      ${filterType.value !== "mcp" && loading && html`
        <div style="text-align:center;padding:40px;"><${Spinner} /> Loading library...</div>
      `}

      ${filterType.value !== "mcp" && !loading && displayed.length === 0 && initialized.value && html`
        <${EmptyState}
          icon="book"
          title="No resources found"
          message=${searchQuery.value
            ? "Try a different search term or clear the filter."
            : "Create your first prompt, agent profile, or skill."}
          action=${searchQuery.value
            ? { label: "Clear search", onClick: () => { searchQuery.value = ""; loadEntries(); } }
            : { label: "➕ New Resource", onClick: () => setEditing({}) }} />
      `}

      ${filterType.value !== "mcp" && !loading && displayed.length > 0 && html`
        <div class="library-grid">
          ${displayed.map((e) => html`
            <${LibraryCard} key=${e.id} entry=${e} onSelect=${handleSelect} />
          `)}
        </div>
      `}

      ${editing && html`
        <${EntryEditor}
          entry=${editing}
          onClose=${() => setEditing(null)}
          onSaved=${handleSaved}
          onDeleted=${handleDeleted} />
      `}
    </div>
  `;
}
