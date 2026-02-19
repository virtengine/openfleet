/* ─────────────────────────────────────────────────────────────
 *  Tab: Settings — Two-mode settings UI
 *  Mode 1: App Preferences (client-side, CloudStorage/localStorage)
 *  Mode 2: Server Config (.env management via settings API)
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm, showAlert } from "../modules/telegram.js";
import { apiFetch, wsConnected } from "../modules/api.js";
import {
  connected,
  statusData,
  executorData,
  configData,
  showToast,
} from "../modules/state.js";
import {
  Card,
  Badge,
  ListItem,
  SkeletonCard,
  Modal,
  ConfirmDialog,
} from "../components/shared.js";
import {
  SegmentedControl,
  Collapsible,
  Toggle,
  SearchInput,
} from "../components/forms.js";
import {
  CATEGORIES,
  SETTINGS_SCHEMA,
  getGroupedSettings,
  validateSetting,
  SENSITIVE_KEYS,
} from "../modules/settings-schema.js";

/* ─── Scoped Styles ─── */
const SETTINGS_STYLES = `
/* Category pill tabs — horizontal scrollable row */
.settings-category-tabs {
  display: flex;
  overflow-x: auto;
  gap: 8px;
  padding: 8px 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.settings-category-tabs::-webkit-scrollbar { display: none; }
.settings-category-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  background: var(--card-bg, rgba(255,255,255,0.04));
  color: var(--text-secondary, #999);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}
.settings-category-tab:hover {
  border-color: var(--accent, #5b6eae);
  color: var(--text-primary, #fff);
}
.settings-category-tab.active {
  background: var(--accent, #5b6eae);
  border-color: var(--accent, #5b6eae);
  color: var(--accent-text, #fff);
  font-weight: 600;
}
.settings-category-tab-icon { font-size: 15px; }
/* Search wrapper */
.settings-search { margin-bottom: 8px; }
/* Floating save bar */
.settings-save-bar {
  position: fixed;
  bottom: 72px;
  left: 0; right: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--glass-bg, rgba(30,30,46,0.85));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid var(--border, rgba(255,255,255,0.08));
  animation: slideUp 0.25s ease;
}
@keyframes slideUp {
  from { transform: translateY(100%); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
}
.settings-save-bar .save-bar-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary, #999);
}
.settings-save-bar .save-bar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
/* Individual setting row */
.setting-row {
  padding: 12px 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.05));
}
.setting-row:last-child { border-bottom: none; }
.setting-row-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.setting-row-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #fff);
}
.setting-row-key {
  font-size: 11px;
  font-family: monospace;
  color: var(--text-tertiary, #666);
  opacity: 0.7;
}
/* Help tooltip */
.setting-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  border: 1px solid var(--border, rgba(255,255,255,0.15));
  background: transparent;
  color: var(--text-secondary, #999);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  position: relative;
}
.setting-help-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--glass-bg, rgba(30,30,46,0.95));
  backdrop-filter: blur(12px);
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary, #bbb);
  min-width: 220px;
  max-width: 320px;
  z-index: 200;
  white-space: normal;
  line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  pointer-events: none;
}
/* Modified dot */
.setting-modified-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--warning, #f5a623);
  flex-shrink: 0;
}
/* Default tag */
.setting-default-tag {
  font-size: 11px;
  color: var(--text-tertiary, #666);
  font-style: italic;
  margin-left: 4px;
}
/* Secret toggle eye button */
.setting-secret-toggle {
  background: transparent;
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  color: var(--text-secondary, #999);
  font-size: 14px;
  flex-shrink: 0;
}
/* Input wrappers */
.setting-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.setting-input-wrap input[type="text"],
.setting-input-wrap input[type="number"],
.setting-input-wrap input[type="password"],
.setting-input-wrap textarea,
.setting-input-wrap select {
  flex: 1;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  background: var(--input-bg, rgba(255,255,255,0.04));
  color: var(--text-primary, #fff);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}
.setting-input-wrap input:focus,
.setting-input-wrap textarea:focus,
.setting-input-wrap select:focus {
  border-color: var(--accent, #5b6eae);
}
.setting-input-wrap textarea {
  min-height: 60px;
  resize: vertical;
  font-family: monospace;
}
.setting-input-wrap select {
  appearance: auto;
}
.setting-unit {
  font-size: 12px;
  color: var(--text-tertiary, #666);
  white-space: nowrap;
}
.setting-validation-error {
  font-size: 12px;
  color: var(--destructive, #e74c3c);
  margin-top: 4px;
  padding-left: 2px;
}
/* Banner styles */
.settings-banner {
  padding: 12px 16px;
  border-radius: 10px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.settings-banner-error {
  background: rgba(231,76,60,0.12);
  border: 1px solid rgba(231,76,60,0.25);
  color: var(--destructive, #e74c3c);
}
.settings-banner-warn {
  background: rgba(245,166,35,0.12);
  border: 1px solid rgba(245,166,35,0.25);
  color: var(--warning, #f5a623);
}
.settings-banner-info {
  background: rgba(90,124,255,0.12);
  border: 1px solid rgba(90,124,255,0.25);
  color: var(--accent, #5a7cff);
}
.settings-banner-text { flex: 1; }
/* Diff display for confirm dialog */
.settings-diff {
  max-height: 300px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 12px;
  background: var(--input-bg, rgba(255,255,255,0.03));
  border-radius: 8px;
  padding: 12px;
  margin: 12px 0;
}
.settings-diff-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
}
.settings-diff-key {
  font-weight: 600;
  color: var(--text-primary, #fff);
  margin-bottom: 2px;
}
.settings-diff-old { color: var(--destructive, #e74c3c); }
.settings-diff-new { color: var(--success, #2ecc71); }
/* Empty search state */
.settings-empty-search {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-secondary, #999);
}
.settings-empty-search-icon { font-size: 32px; margin-bottom: 8px; }
/* Category description text */
.settings-cat-desc {
  font-size: 12px;
  color: var(--text-tertiary, #666);
  margin-bottom: 8px;
  padding: 0 2px;
}
`;

/* ─── Inject styles once ─── */
let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const el = document.createElement("style");
  el.textContent = SETTINGS_STYLES;
  document.head.appendChild(el);
}

/* ─── CloudStorage helpers (for App Preferences mode) ─── */
function cloudGet(key) {
  return new Promise((resolve) => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.CloudStorage) {
      tg.CloudStorage.getItem(key, (err, val) => {
        if (err || val == null) resolve(null);
        else {
          try {
            resolve(JSON.parse(val));
          } catch {
            resolve(val);
          }
        }
      });
    } else {
      try {
        const v = localStorage.getItem("ve_settings_" + key);
        resolve(v != null ? JSON.parse(v) : null);
      } catch {
        resolve(null);
      }
    }
  });
}

function cloudSet(key, value) {
  const tg = globalThis.Telegram?.WebApp;
  const str = JSON.stringify(value);
  if (tg?.CloudStorage) {
    tg.CloudStorage.setItem(key, str, () => {});
  } else {
    try {
      localStorage.setItem("ve_settings_" + key, str);
    } catch {
      /* noop */
    }
  }
}

function cloudRemove(key) {
  const tg = globalThis.Telegram?.WebApp;
  if (tg?.CloudStorage) {
    tg.CloudStorage.removeItem(key, () => {});
  } else {
    try {
      localStorage.removeItem("ve_settings_" + key);
    } catch {
      /* noop */
    }
  }
}

/* ─── Version info ─── */
const APP_VERSION = "1.0.0";
const APP_NAME = "VirtEngine Control Center";

/* ─── Fuzzy search helper ─── */
function fuzzyMatch(needle, haystack) {
  if (!needle) return true;
  const lower = haystack.toLowerCase();
  const terms = needle.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => lower.includes(t));
}

/* ─── Mask a sensitive value for display ─── */
function maskValue(val) {
  if (!val || val === "") return "";
  const s = String(val);
  if (s.length <= 4) return "••••";
  return "••••••" + s.slice(-4);
}

/* ═══════════════════════════════════════════════════════════════
 *  ServerConfigMode — .env management UI
 * ═══════════════════════════════════════════════════════════════ */
function ServerConfigMode() {
  /* Data loading state */
  const [serverData, setServerData] = useState(null);     // { KEY: "value" } from API
  const [serverMeta, setServerMeta] = useState(null);     // { envPath, configPath, configDir }
  const [configSync, setConfigSync] = useState(null);     // { total, updated, skipped, configPath }
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);

  /* Local edits: Map of key → edited value (string) */
  const [edits, setEdits] = useState({});
  /* Validation errors: Map of key → error string */
  const [errors, setErrors] = useState({});
  /* Secret visibility: Set of keys currently unmasked */
  const [visibleSecrets, setVisibleSecrets] = useState({});
  /* Help tooltips: key of currently shown tooltip */
  const [activeTooltip, setActiveTooltip] = useState(null);

  /* Active category tab */
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id);
  /* Search query */
  const [searchQuery, setSearchQuery] = useState("");
  /* Show advanced settings */
  const [showAdvanced, setShowAdvanced] = useState(false);
  /* Save flow */
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const tooltipTimer = useRef(null);

  /* ─── Load server settings on mount ─── */
  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/settings");
      if (res?.ok && res.data) {
        setServerData(res.data);
        setServerMeta(res.meta || null);
        setConfigSync(null);
      } else {
        throw new Error(res?.error || "Unexpected response format");
      }
    } catch (err) {
      setLoadError(err.message || "Failed to load settings");
      setServerData(null);
      setServerMeta(null);
      setConfigSync(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  /* ─── Grouped settings with search + advanced filter ─── */
  const grouped = useMemo(() => getGroupedSettings(showAdvanced), [showAdvanced]);

  /* Filtered settings when searching */
  const filteredSettings = useMemo(() => {
    if (!searchQuery.trim()) return null; // null = not searching
    const results = [];
    for (const def of SETTINGS_SCHEMA) {
      if (!showAdvanced && def.advanced) continue;
      const haystack = `${def.key} ${def.label} ${def.description || ""}`;
      if (fuzzyMatch(searchQuery, haystack)) results.push(def);
    }
    return results;
  }, [searchQuery, showAdvanced]);

  /* ─── Value resolution: edited value → server value → empty ─── */
  const getValue = useCallback(
    (key) => {
      if (key in edits) return edits[key];
      if (serverData && key in serverData) return String(serverData[key] ?? "");
      return "";
    },
    [edits, serverData],
  );

  /* ─── Determine if a value matches its default ─── */
  const isDefault = useCallback(
    (def) => {
      if (def.defaultVal == null) return false;
      const current = getValue(def.key);
      return current === "" || current === String(def.defaultVal);
    },
    [getValue],
  );

  /* ─── Determine if a value was modified from loaded state ─── */
  const isModified = useCallback(
    (key) => key in edits,
    [edits],
  );

  /* Count of unsaved changes */
  const changeCount = useMemo(() => Object.keys(edits).length, [edits]);

  /* Any setting with restart: true in the changes? */
  const hasRestartSetting = useMemo(() => {
    return Object.keys(edits).some((key) => {
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      return def?.restart;
    });
  }, [edits]);

  /* ─── Handlers ─── */
  const handleChange = useCallback(
    (key, value) => {
      haptic("light");
      setEdits((prev) => {
        const original = serverData?.[key] != null ? String(serverData[key]) : "";
        // If the new value matches the original, remove the edit
        if (value === original) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: value };
      });
      // Validate inline
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      if (def) {
        const result = validateSetting(def, value);
        setErrors((prev) => {
          if (result.valid) {
            const next = { ...prev };
            delete next[key];
            return next;
          }
          return { ...prev, [key]: result.error };
        });
      }
    },
    [serverData],
  );

  const handleDiscard = useCallback(() => {
    haptic("medium");
    setEdits({});
    setErrors({});
    showToast("Changes discarded", "info");
  }, []);

  /* ─── Save flow ─── */
  const handleSaveClick = useCallback(() => {
    // Validate all changed settings
    const newErrors = {};
    let hasError = false;
    for (const [key, value] of Object.entries(edits)) {
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      if (!def) continue;
      const result = validateSetting(def, value);
      if (!result.valid) {
        newErrors[key] = result.error;
        hasError = true;
      }
    }
    setErrors((prev) => ({ ...prev, ...newErrors }));
    if (hasError) {
      showToast("Fix validation errors before saving", "error");
      haptic("heavy");
      return;
    }
    haptic("medium");
    setConfirmOpen(true);
  }, [edits]);

  const handleConfirmSave = useCallback(async () => {
    setConfirmOpen(false);
    setSaving(true);
    try {
      const changes = {};
      for (const [key, value] of Object.entries(edits)) {
        changes[key] = value;
      }
      const res = await apiFetch("/api/settings/update", {
        method: "POST",
        body: JSON.stringify({ changes }),
      });
      if (res?.ok) {
        showToast("Settings saved successfully", "success");
        haptic("medium");
        const updatedConfig = Array.isArray(res.updatedConfig) ? res.updatedConfig : [];
        const changeKeys = Object.keys(changes);
        const skipped = changeKeys.filter((key) => !updatedConfig.includes(key));
        setConfigSync({
          total: changeKeys.length,
          updated: updatedConfig.length,
          skipped,
          configPath: res.configPath || serverMeta?.configPath || null,
        });
        if (res.configPath && (!serverMeta || serverMeta.configPath !== res.configPath)) {
          setServerMeta((prev) => ({
            ...(prev || {}),
            configPath: res.configPath,
            configDir: res.configDir || prev?.configDir,
          }));
        }
        // Merge changes into serverData so they appear as the new baseline
        setServerData((prev) => ({ ...prev, ...changes }));
        setEdits({});
        if (hasRestartSetting) {
          showToast("Settings take effect after auto-reload (~2 seconds)", "info");
        }
      } else {
        throw new Error(res?.error || "Save failed");
      }
    } catch (err) {
      let parsed = null;
      try {
        parsed = JSON.parse(err.message);
      } catch {
        parsed = null;
      }
      if (parsed?.fieldErrors && typeof parsed.fieldErrors === "object") {
        setErrors((prev) => ({ ...prev, ...parsed.fieldErrors }));
      }
      const message = parsed?.error || err.message;
      showToast(`Save failed: ${message}`, "error");
      haptic("heavy");
    } finally {
      setSaving(false);
    }
  }, [edits, hasRestartSetting, serverMeta]);

  const handleCancelSave = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  /* ─── Tooltip management ─── */
  const showTooltipFor = useCallback((key) => {
    clearTimeout(tooltipTimer.current);
    setActiveTooltip(key);
    tooltipTimer.current = setTimeout(() => setActiveTooltip(null), 4000);
  }, []);

  /* ─── Secret visibility toggle ─── */
  const toggleSecret = useCallback((key) => {
    haptic("light");
    setVisibleSecrets((prev) => {
      const next = { ...prev };
      next[key] = !next[key];
      return next;
    });
  }, []);

  /* ─── Build the diff for the confirm dialog ─── */
  const diffEntries = useMemo(() => {
    return Object.entries(edits).map(([key, newVal]) => {
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      const oldVal = serverData?.[key] != null ? String(serverData[key]) : "(unset)";
      const displayOld = def?.sensitive ? maskValue(oldVal) : oldVal || "(unset)";
      const displayNew = def?.sensitive ? maskValue(newVal) : newVal || "(unset)";
      return { key, label: def?.label || key, oldVal: displayOld, newVal: displayNew };
    });
  }, [edits, serverData]);

  /* ═══════════════════════════════════════════════
   *  Render a single setting control
   * ═══════════════════════════════════════════════ */
  const renderSetting = useCallback(
    (def) => {
      const value = getValue(def.key);
      const modified = isModified(def.key);
      const defaultMatch = isDefault(def);
      const error = errors[def.key];
      const isSensitive = def.sensitive;
      const secretVisible = visibleSecrets[def.key];

      /* Choose input control based on type */
      let control = null;

      switch (def.type) {
        case "boolean": {
          const checked =
            value === "true" || value === "1" || value === true;
          control = html`
            <${Toggle}
              checked=${checked}
              onChange=${(v) => handleChange(def.key, v ? "true" : "false")}
            />
          `;
          break;
        }

        case "select": {
          const opts = def.options || [];
          if (opts.length <= 4) {
            // SegmentedControl for ≤4 options
            control = html`
              <${SegmentedControl}
                options=${opts.map((o) => ({ value: o, label: o }))}
                value=${value || (def.defaultVal != null ? String(def.defaultVal) : "")}
                onChange=${(v) => handleChange(def.key, v)}
              />
            `;
          } else {
            // Dropdown for >4 options
            control = html`
              <div class="setting-input-wrap">
                <select
                  value=${value || (def.defaultVal != null ? String(def.defaultVal) : "")}
                  onChange=${(e) => handleChange(def.key, e.target.value)}
                >
                  ${opts.map(
                    (o) => html`<option key=${o} value=${o}>${o}</option>`,
                  )}
                </select>
              </div>
            `;
          }
          break;
        }

        case "secret": {
          const displayValue =
            secretVisible ? value : (value ? maskValue(value) : "");
          control = html`
            <div class="setting-input-wrap">
              <input
                type=${secretVisible ? "text" : "password"}
                value=${secretVisible ? value : ""}
                placeholder=${value && !secretVisible ? displayValue : "Enter value…"}
                onInput=${(e) => handleChange(def.key, e.target.value)}
                onFocus=${() => {
                  if (!secretVisible) toggleSecret(def.key);
                }}
              />
              <button
                class="setting-secret-toggle"
                onClick=${() => toggleSecret(def.key)}
                title=${secretVisible ? "Hide" : "Show"}
              >
                ${secretVisible ? "🙈" : "👁️"}
              </button>
            </div>
          `;
          break;
        }

        case "number": {
          control = html`
            <div class="setting-input-wrap">
              <input
                type="number"
                value=${value}
                placeholder=${def.defaultVal != null ? String(def.defaultVal) : ""}
                min=${def.min}
                max=${def.max}
                onInput=${(e) => handleChange(def.key, e.target.value)}
              />
              ${def.unit && html`<span class="setting-unit">${def.unit}</span>`}
            </div>
          `;
          break;
        }

        case "text": {
          control = html`
            <div class="setting-input-wrap">
              <textarea
                value=${value}
                placeholder=${def.defaultVal != null ? String(def.defaultVal) : "Enter value…"}
                onInput=${(e) => handleChange(def.key, e.target.value)}
                rows="3"
              />
            </div>
          `;
          break;
        }

        default: {
          // string type
          control = html`
            <div class="setting-input-wrap">
              <input
                type="text"
                value=${value}
                placeholder=${def.defaultVal != null ? String(def.defaultVal) : "Enter value…"}
                onInput=${(e) => handleChange(def.key, e.target.value)}
              />
            </div>
          `;
          break;
        }
      }

      return html`
        <div class="setting-row" key=${def.key}>
          <div class="setting-row-header">
            ${modified && html`<span class="setting-modified-dot" title="Unsaved change"></span>`}
            <span class="setting-row-label">${def.label}</span>
            ${defaultMatch && !modified && html`<span class="setting-default-tag">(default)</span>`}
            ${def.restart && html`<${Badge} status="warning" text="restart" className="badge-sm" />`}
            <button
              class="setting-help-btn"
              onClick=${(e) => {
                e.stopPropagation();
                showTooltipFor(def.key);
              }}
              title=${def.description}
            >
              ?
              ${activeTooltip === def.key &&
              html`<div class="setting-help-tooltip">${def.description}</div>`}
            </button>
          </div>
          <div class="setting-row-key">${def.key}</div>
          ${control}
          ${error && html`<div class="setting-validation-error">⚠ ${error}</div>`}
        </div>
      `;
    },
    [getValue, isModified, isDefault, errors, visibleSecrets, activeTooltip, handleChange, toggleSecret, showTooltipFor],
  );

  /* ═══════════════════════════════════════════════
   *  Render
   * ═══════════════════════════════════════════════ */

  /* Backend health banner */
  const wsOk = wsConnected.value;

  return html`
    <!-- Health banners -->
    ${loadError &&
    html`
      <div class="settings-banner settings-banner-error">
        <span>⚠️</span>
        <span class="settings-banner-text">
          <strong>Backend Unreachable</strong> — ${loadError}
        </span>
        <button class="btn btn-ghost btn-sm" onClick=${fetchSettings}>Retry</button>
      </div>
    `}

    ${!wsOk &&
    !loadError &&
    html`
      <div class="settings-banner settings-banner-warn">
        <span>⚡</span>
        <span class="settings-banner-text">Connection lost — reconnecting…</span>
      </div>
    `}

    ${configSync &&
    html`
      <div class="settings-banner ${configSync.skipped?.length ? "settings-banner-warn" : "settings-banner-info"}">
        <span>💾</span>
        <span class="settings-banner-text">
          ${configSync.skipped?.length
            ? `Saved ${configSync.total} settings; synced ${configSync.updated} to config file.`
            : `Synced ${configSync.updated} settings to config file.`}
          ${configSync.configPath &&
          html`<div style="margin-top:4px;font-size:12px;color:var(--text-secondary, #bbb)">
            Config: <code>${configSync.configPath}</code>
          </div>`}
          ${configSync.skipped?.length &&
          html`<div style="margin-top:2px;font-size:12px;color:var(--text-secondary, #bbb)">
            Not supported in config: ${configSync.skipped.slice(0, 4).join(", ")}${configSync.skipped.length > 4 ? ` +${configSync.skipped.length - 4} more` : ""}
          </div>`}
        </span>
      </div>
    `}

    ${serverMeta?.configPath &&
    !loadError &&
    html`
      <div class="settings-banner settings-banner-info">
        <span>🧭</span>
        <span class="settings-banner-text">
          Settings are saved to <code>${serverMeta.envPath}</code> and synced to
          <code>${serverMeta.configPath}</code> for supported keys.
        </span>
      </div>
    `}

    <!-- Search bar -->
    <div class="settings-search">
      <${SearchInput}
        value=${searchQuery}
        onInput=${(e) => setSearchQuery(e.target.value)}
        onClear=${() => setSearchQuery("")}
        placeholder="Search settings…"
      />
    </div>

    <!-- Advanced toggle -->
    <div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:8px">
      <${Toggle}
        checked=${showAdvanced}
        onChange=${(v) => { setShowAdvanced(v); haptic("light"); }}
        label="Show Advanced"
      />
    </div>

    <!-- Loading state -->
    ${loading &&
    html`
      <${SkeletonCard} height="40px" />
      <${SkeletonCard} height="120px" />
      <${SkeletonCard} height="120px" />
    `}

    <!-- Content: search results or category browsing -->
    ${!loading &&
    serverData &&
    (() => {
      /* ── Search mode ── */
      if (filteredSettings) {
        if (filteredSettings.length === 0) {
          return html`
            <div class="settings-empty-search">
              <div class="settings-empty-search-icon">🔍</div>
              <div>No settings match "<strong>${searchQuery}</strong>"</div>
              <div class="meta-text mt-sm">Try a different search term</div>
            </div>
          `;
        }
        return html`
          <${Card}>
            <div class="card-subtitle mb-sm">
              ${filteredSettings.length} result${filteredSettings.length !== 1 ? "s" : ""}
            </div>
            ${filteredSettings.map((def) => renderSetting(def))}
          <//>
        `;
      }

      /* ── Category browsing mode ── */
      const catDefs = grouped.get(activeCategory) || [];
      const activeCat = CATEGORIES.find((c) => c.id === activeCategory);

      return html`
        <!-- Category tabs -->
        <div class="settings-category-tabs">
          ${CATEGORIES.map(
            (cat) => html`
              <button
                key=${cat.id}
                class="settings-category-tab ${activeCategory === cat.id ? "active" : ""}"
                onClick=${() => {
                  setActiveCategory(cat.id);
                  haptic("light");
                }}
              >
                <span class="settings-category-tab-icon">${cat.icon}</span>
                ${cat.label}
              </button>
            `,
          )}
        </div>

        <!-- Category description -->
        ${activeCat?.description &&
        html`<div class="settings-cat-desc">${activeCat.description}</div>`}

        <!-- Settings list for active category -->
        ${catDefs.length === 0
          ? html`
              <${Card}>
                <div class="meta-text" style="text-align:center;padding:24px 0">
                  No settings in this category${!showAdvanced ? " (try enabling Advanced)" : ""}
                </div>
              <//>
            `
          : html`
              <${Card}>
                ${catDefs.map((def) => renderSetting(def))}
              <//>
            `}
      `;
    })()}

    <!-- Empty state when no data and no error -->
    ${!loading &&
    !serverData &&
    !loadError &&
    html`
      <${Card}>
        <div class="meta-text" style="text-align:center;padding:24px 0">
          No settings data available.
        </div>
      <//>
    `}

    <!-- Floating save bar -->
    ${changeCount > 0 &&
    html`
      <div class="settings-save-bar">
        <div class="save-bar-info">
          <span class="setting-modified-dot"></span>
          <span>${changeCount} unsaved change${changeCount !== 1 ? "s" : ""}</span>
        </div>
        <div class="save-bar-actions">
          <button class="btn btn-ghost btn-sm" onClick=${handleDiscard}>
            Discard
          </button>
          <button
            class="btn btn-primary btn-sm"
            onClick=${handleSaveClick}
            disabled=${saving}
          >
            ${saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    `}

    <!-- Confirm dialog with diff -->
    ${confirmOpen &&
    html`
      <${Modal} title="Confirm Changes" open=${true} onClose=${handleCancelSave}>
        <div style="padding:4px 0">
          <div class="meta-text mb-sm">
            Review ${diffEntries.length} change${diffEntries.length !== 1 ? "s" : ""} before saving:
          </div>
          <div class="settings-diff">
            ${diffEntries.map(
              (d) => html`
                <div class="settings-diff-row" key=${d.key}>
                  <div class="settings-diff-key">${d.label}</div>
                  <div class="settings-diff-old">− ${d.oldVal}</div>
                  <div class="settings-diff-new">+ ${d.newVal}</div>
                </div>
              `,
            )}
          </div>
          ${hasRestartSetting &&
          html`
            <div class="settings-banner settings-banner-warn" style="margin-top:8px">
              <span>🔄</span>
              <span class="settings-banner-text">
                Some changes require a restart. The server will auto-reload (~2 seconds).
              </span>
            </div>
          `}
          <div class="btn-row mt-md" style="justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost" onClick=${handleCancelSave}>Cancel</button>
            <button class="btn btn-primary" onClick=${handleConfirmSave} disabled=${saving}>
              ${saving ? "Saving…" : "Confirm & Save"}
            </button>
          </div>
        </div>
      <//>
    `}
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  AppPreferencesMode — existing client-side preferences
 * ═══════════════════════════════════════════════════════════════ */
function AppPreferencesMode() {
  const tg = globalThis.Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;

  /* Preferences (loaded from CloudStorage) */
  const [fontSize, setFontSize] = useState("medium");
  const [notifyUpdates, setNotifyUpdates] = useState(true);
  const [notifyErrors, setNotifyErrors] = useState(true);
  const [notifyComplete, setNotifyComplete] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [defaultMaxParallel, setDefaultMaxParallel] = useState(4);
  const [defaultSdk, setDefaultSdk] = useState("auto");
  const [defaultRegion, setDefaultRegion] = useState("auto");
  const [showRawJson, setShowRawJson] = useState(false);
  const [loaded, setLoaded] = useState(false);

  /* Load prefs from CloudStorage on mount */
  useEffect(() => {
    (async () => {
      const [fs, nu, ne, nc, dm, dmp, ds, dr] = await Promise.all([
        cloudGet("fontSize"),
        cloudGet("notifyUpdates"),
        cloudGet("notifyErrors"),
        cloudGet("notifyComplete"),
        cloudGet("debugMode"),
        cloudGet("defaultMaxParallel"),
        cloudGet("defaultSdk"),
        cloudGet("defaultRegion"),
      ]);
      if (fs) setFontSize(fs);
      if (nu != null) setNotifyUpdates(nu);
      if (ne != null) setNotifyErrors(ne);
      if (nc != null) setNotifyComplete(nc);
      if (dm != null) setDebugMode(dm);
      if (dmp != null) setDefaultMaxParallel(dmp);
      if (ds) setDefaultSdk(ds);
      if (dr) setDefaultRegion(dr);
      setLoaded(true);
    })();
  }, []);

  /* Persist helpers */
  const toggle = useCallback((key, getter, setter) => {
    const next = !getter;
    setter(next);
    cloudSet(key, next);
    haptic();
  }, []);

  const handleFontSize = (v) => {
    setFontSize(v);
    cloudSet("fontSize", v);
    haptic();
    const map = { small: "13px", medium: "15px", large: "17px" };
    document.documentElement.style.setProperty(
      "--base-font-size",
      map[v] || "15px",
    );
  };

  const handleDefaultMaxParallel = (v) => {
    const val = Math.max(1, Math.min(20, Number(v)));
    setDefaultMaxParallel(val);
    cloudSet("defaultMaxParallel", val);
    haptic();
  };

  const handleDefaultSdk = (v) => {
    setDefaultSdk(v);
    cloudSet("defaultSdk", v);
    haptic();
  };

  const handleDefaultRegion = (v) => {
    setDefaultRegion(v);
    cloudSet("defaultRegion", v);
    haptic();
  };

  /* Clear cache */
  const handleClearCache = async () => {
    const ok = await showConfirm("Clear all cached data and preferences?");
    if (!ok) return;
    haptic("medium");
    const keys = [
      "fontSize",
      "notifyUpdates",
      "notifyErrors",
      "notifyComplete",
      "debugMode",
      "defaultMaxParallel",
      "defaultSdk",
      "defaultRegion",
    ];
    for (const k of keys) cloudRemove(k);
    showToast("Cache cleared — reload to apply", "success");
  };

  /* Reset all settings */
  const handleReset = async () => {
    const ok = await showConfirm("Reset ALL settings to defaults?");
    if (!ok) return;
    haptic("heavy");
    const keys = [
      "fontSize",
      "notifyUpdates",
      "notifyErrors",
      "notifyComplete",
      "debugMode",
      "defaultMaxParallel",
      "defaultSdk",
      "defaultRegion",
    ];
    for (const k of keys) cloudRemove(k);
    setFontSize("medium");
    setNotifyUpdates(true);
    setNotifyErrors(true);
    setNotifyComplete(true);
    setDebugMode(false);
    setDefaultMaxParallel(4);
    setDefaultSdk("auto");
    setDefaultRegion("auto");
    document.documentElement.style.removeProperty("--base-font-size");
    showToast("Settings reset", "success");
  };

  /* Raw status JSON */
  const rawJson =
    debugMode && showRawJson
      ? JSON.stringify(
          { status: statusData?.value, executor: executorData?.value },
          null,
          2,
        )
      : "";

  return html`
    ${!loaded && html`<${Card} title="Loading Settings…"><${SkeletonCard} /><//>`}

    <!-- ─── Account ─── -->
    <${Collapsible} title="👤 Account" defaultOpen=${true}>
      <${Card}>
        <div class="settings-row">
          ${user?.photo_url &&
          html`
            <img
              src=${user.photo_url}
              alt="avatar"
              class="settings-avatar"
              style="width:48px;height:48px;border-radius:50%;margin-right:12px"
            />
          `}
          <div>
            <div style="font-weight:600;font-size:15px">
              ${user?.first_name || "Unknown"} ${user?.last_name || ""}
            </div>
            ${user?.username &&
            html`<div class="meta-text">@${user.username}</div>`}
          </div>
        </div>
        <div class="meta-text mt-sm">App version: ${APP_VERSION}</div>
      <//>
    <//>

    <!-- ─── Appearance ─── -->
    <${Collapsible} title="🎨 Appearance" defaultOpen=${false}>
      <${Card}>
        <div class="card-subtitle mb-sm">Color Scheme</div>
        <div class="meta-text mb-md">
          Follows your Telegram theme automatically.
          ${tg?.colorScheme
            ? html` Current: <strong>${tg.colorScheme}</strong>`
            : ""}
        </div>
        <div class="card-subtitle mb-sm">Font Size</div>
        <${SegmentedControl}
          options=${[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
          value=${fontSize}
          onChange=${handleFontSize}
        />
      <//>
    <//>

    <!-- ─── Notifications ─── -->
    <${Collapsible} title="🔔 Notifications" defaultOpen=${false}>
      <${Card}>
        <${ListItem}
          title="Real-time Updates"
          subtitle="Show live data refresh indicators"
          trailing=${html`
            <${Toggle}
              checked=${notifyUpdates}
              onChange=${() =>
                toggle("notifyUpdates", notifyUpdates, setNotifyUpdates)}
            />
          `}
        />
        <${ListItem}
          title="Error Alerts"
          subtitle="Toast notifications for errors"
          trailing=${html`
            <${Toggle}
              checked=${notifyErrors}
              onChange=${() =>
                toggle("notifyErrors", notifyErrors, setNotifyErrors)}
            />
          `}
        />
        <${ListItem}
          title="Task Completion"
          subtitle="Notify when tasks finish"
          trailing=${html`
            <${Toggle}
              checked=${notifyComplete}
              onChange=${() =>
                toggle("notifyComplete", notifyComplete, setNotifyComplete)}
            />
          `}
        />
      <//>
    <//>

    <!-- ─── Data & Storage ─── -->
    <${Collapsible} title="💾 Data & Storage" defaultOpen=${false}>
      <${Card}>
        <${ListItem}
          title="WebSocket"
          subtitle="Live connection status"
          trailing=${html`
            <${Badge}
              status=${connected?.value ? "done" : "error"}
              text=${connected?.value ? "Connected" : "Offline"}
            />
          `}
        />
        <${ListItem}
          title="API Endpoint"
          subtitle=${globalThis.location?.origin || "unknown"}
        />
        <${ListItem}
          title="Clear Cache"
          subtitle="Remove all stored preferences"
          trailing=${html`
            <button class="btn btn-ghost btn-sm" onClick=${handleClearCache}>
              🗑 Clear
            </button>
          `}
        />
      <//>
    <//>

    <!-- ─── Executor Defaults ─── -->
    <${Collapsible} title="⚙️ Executor Defaults" defaultOpen=${false}>
      <${Card}>
        <div class="card-subtitle mb-sm">Default Max Parallel</div>
        <div class="range-row mb-md">
          <input
            type="range"
            min="1"
            max="20"
            step="1"
            value=${defaultMaxParallel}
            onInput=${(e) => setDefaultMaxParallel(Number(e.target.value))}
            onChange=${(e) => handleDefaultMaxParallel(Number(e.target.value))}
          />
          <span class="pill">${defaultMaxParallel}</span>
        </div>

        <div class="card-subtitle mb-sm">Default SDK</div>
        <${SegmentedControl}
          options=${[
            { value: "codex", label: "Codex" },
            { value: "copilot", label: "Copilot" },
            { value: "claude", label: "Claude" },
            { value: "auto", label: "Auto" },
          ]}
          value=${defaultSdk}
          onChange=${handleDefaultSdk}
        />

        <div class="card-subtitle mt-md mb-sm">Default Region</div>
        ${(() => {
          const regions = configData.value?.regions || ["auto"];
          const regionOptions = regions.map((r) => ({
            value: r,
            label: r.charAt(0).toUpperCase() + r.slice(1),
          }));
          return regions.length > 1
            ? html`<${SegmentedControl}
                options=${regionOptions}
                value=${defaultRegion}
                onChange=${handleDefaultRegion}
              />`
            : html`<div class="meta-text">Region: ${regions[0]}</div>`;
        })()}
      <//>
    <//>

    <!-- ─── Advanced ─── -->
    <${Collapsible} title="🔧 Advanced" defaultOpen=${false}>
      <${Card}>
        <${ListItem}
          title="Debug Mode"
          subtitle="Show raw data and extra diagnostics"
          trailing=${html`
            <${Toggle}
              checked=${debugMode}
              onChange=${() => toggle("debugMode", debugMode, setDebugMode)}
            />
          `}
        />

        ${debugMode &&
        html`
          <${ListItem}
            title="Raw Status JSON"
            subtitle="View raw API response data"
            trailing=${html`
              <button
                class="btn btn-ghost btn-sm"
                onClick=${() => {
                  setShowRawJson(!showRawJson);
                  haptic();
                }}
              >
                ${showRawJson ? "Hide" : "Show"}
              </button>
            `}
          />
          ${showRawJson &&
          html`
            <div class="log-box mt-sm" style="max-height:300px;font-size:11px">
              ${rawJson}
            </div>
          `}
        `}

        <${ListItem}
          title="Reset All Settings"
          subtitle="Restore defaults"
          trailing=${html`
            <button class="btn btn-danger btn-sm" onClick=${handleReset}>
              Reset
            </button>
          `}
        />
      <//>
    <//>

    <!-- ─── About ─── -->
    <${Collapsible} title="ℹ️ About" defaultOpen=${false}>
      <${Card}>
        <div style="text-align:center;padding:12px 0">
          <div style="font-size:18px;font-weight:700;margin-bottom:4px">
            ${APP_NAME}
          </div>
          <div class="meta-text">Version ${APP_VERSION}</div>
          <div class="meta-text mt-sm">
            Telegram Mini App for VirtEngine orchestrator management
          </div>
          <div class="meta-text mt-sm">
            Built with Preact + HTM · No build step
          </div>
          <div class="btn-row mt-md" style="justify-content:center">
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => {
                haptic();
                const tg = globalThis.Telegram?.WebApp;
                if (tg?.openLink)
                  tg.openLink("https://github.com/virtengine/virtengine");
                else
                  globalThis.open(
                    "https://github.com/virtengine/virtengine",
                    "_blank",
                  );
              }}
            >
              GitHub
            </button>
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => {
                haptic();
                const tg = globalThis.Telegram?.WebApp;
                if (tg?.openLink) tg.openLink("https://docs.virtengine.com");
                else globalThis.open("https://docs.virtengine.com", "_blank");
              }}
            >
              Docs
            </button>
          </div>
        </div>
      <//>
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  SettingsTab — Top-level with two-mode segmented control
 * ═══════════════════════════════════════════════════════════════ */
export function SettingsTab() {
  const [mode, setMode] = useState("preferences");

  /* Inject scoped CSS on first render */
  useEffect(() => { injectStyles(); }, []);

  return html`
    <!-- Top-level mode switcher -->
    <div style="margin-bottom:12px">
      <${SegmentedControl}
        options=${[
          { value: "preferences", label: "App Preferences" },
          { value: "server", label: "Server Config" },
        ]}
        value=${mode}
        onChange=${(v) => {
          setMode(v);
          haptic("light");
        }}
      />
    </div>

    ${mode === "preferences"
      ? html`<${AppPreferencesMode} />`
      : html`<${ServerConfigMode} />`}
  `;
}
