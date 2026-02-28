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
const filterType = signal("all"); // "all" | "prompt" | "agent" | "skill"
const searchQuery = signal("");

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

/* ═══════════════════════════════════════════════════════════════
 *  Icons per type
 * ═══════════════════════════════════════════════════════════════ */

const TYPE_ICONS = { prompt: ":edit:", agent: ":bot:", skill: ":cpu:" };
const TYPE_LABELS = { prompt: "Prompt", agent: "Agent Profile", skill: "Skill" };
const TYPE_COLORS = { prompt: "#58a6ff", agent: "#af7bff", skill: "#3fb950" };

/* ═══════════════════════════════════════════════════════════════
 *  Sub-components
 * ═══════════════════════════════════════════════════════════════ */

function LibraryStats() {
  const all = entries.value;
  const counts = { prompt: 0, agent: 0, skill: 0 };
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
    </div>
  `;
}

function TypePills() {
  const types = [
    { id: "all", label: "All" },
    { id: "prompt", label: `${TYPE_ICONS.prompt} Prompts` },
    { id: "agent", label: `${TYPE_ICONS.agent} Agents` },
    { id: "skill", label: `${TYPE_ICONS.skill} Skills` },
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
            : "Markdown format. Referenced in workflows as {{skill:name}}."}
        </div>

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
        <h2>${iconText(":u1f4da: Library")}</h2>
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
            placeholder="Search prompts, agents, skills..." />
        </div>
        <${TypePills} />
      </div>

      <${ProfileMatcher} />
      <${ScopeDetector} />

      ${loading && html`
        <div style="text-align:center;padding:40px;"><${Spinner} /> Loading library...</div>
      `}

      ${!loading && displayed.length === 0 && initialized.value && html`
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

      ${!loading && displayed.length > 0 && html`
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
