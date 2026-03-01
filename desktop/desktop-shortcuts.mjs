/**
 * desktop-shortcuts.mjs
 *
 * Keyboard shortcut manager for the Bosun desktop app.
 *
 * Responsibilities:
 *  - Defines the canonical catalog of every available shortcut.
 *  - Persists user customizations to {configDir}/desktop-shortcuts.json.
 *  - Registers / unregisters Electron global shortcuts.
 *  - Provides the IPC payload for the settings UI.
 *  - Detects accelerator conflicts before applying changes.
 *
 * Scopes
 *  - "global" : fires system-wide even when the app is in the background.
 *  - "local"  : fires only when the app is focused (wired as menu accelerators).
 */

import { globalShortcut } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ── Scope constants ───────────────────────────────────────────────────────────

/** Fires system-wide, even when Bosun is in the background. */
export const SCOPE_GLOBAL = "global";

/** Fires only when the Bosun window is focused (menu accelerator). */
export const SCOPE_LOCAL = "local";

// ── Default catalog ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} ShortcutDef
 * @property {string}  id                 Unique identifier used as a key.
 * @property {string}  label              Human-readable name shown in UI.
 * @property {string}  description        Longer description for tooltips/help.
 * @property {string}  defaultAccelerator Default Electron accelerator string.
 * @property {string}  scope              "global" | "local"
 * @property {string}  [group]            Optional display grouping.
 */

/** @type {ShortcutDef[]} */
export const DEFAULT_SHORTCUTS = [
  // ── Global ─ fire from anywhere on the desktop ────────────────────────────
  {
    id: "bosun.focus",
    label: "Focus Bosun",
    description: "Bring the Bosun window to front from anywhere on your desktop",
    defaultAccelerator: "CmdOrCtrl+Shift+B",
    scope: SCOPE_GLOBAL,
    group: "Global",
  },
  {
    id: "bosun.quickchat",
    label: "Quick New Chat",
    description: "Focus Bosun and immediately open a brand-new chat session",
    defaultAccelerator: "CmdOrCtrl+Shift+N",
    scope: SCOPE_GLOBAL,
    group: "Global",
  },
  {
    id: "bosun.voice.call",
    label: "Start Voice Call",
    description: "Open the voice companion and start a voice call",
    defaultAccelerator: "CmdOrCtrl+Shift+Space",
    scope: SCOPE_GLOBAL,
    group: "Global",
  },
  {
    id: "bosun.voice.video",
    label: "Start Video Call",
    description: "Open the voice companion and start a video call",
    defaultAccelerator: "CmdOrCtrl+Shift+K",
    scope: SCOPE_GLOBAL,
    group: "Global",
  },
  {
    id: "bosun.voice.toggle",
    label: "Toggle Voice Companion",
    description: "Show or hide the floating voice companion window",
    defaultAccelerator: "CmdOrCtrl+Shift+V",
    scope: SCOPE_GLOBAL,
    group: "Global",
  },

  // ── Local ─ menu accelerators, only when app is focused ───────────────────
  {
    id: "app.newchat",
    label: "New Chat",
    description: "Open a new chat session",
    defaultAccelerator: "CmdOrCtrl+N",
    scope: SCOPE_LOCAL,
    group: "File",
  },
  {
    id: "app.settings",
    label: "Preferences",
    description: "Open the Bosun settings panel",
    defaultAccelerator: "CmdOrCtrl+,",
    scope: SCOPE_LOCAL,
    group: "File",
  },
  {
    id: "bosun.navigate.home",
    label: "Dashboard",
    description: "Navigate to the main Bosun dashboard",
    defaultAccelerator: "CmdOrCtrl+H",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.agents",
    label: "Agents",
    description: "Navigate to the Agents panel",
    defaultAccelerator: "CmdOrCtrl+Shift+A",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.tasks",
    label: "Tasks",
    description: "Navigate to the Tasks panel",
    defaultAccelerator: "CmdOrCtrl+Shift+T",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.logs",
    label: "Logs",
    description: "Navigate to the Logs panel",
    defaultAccelerator: "CmdOrCtrl+Shift+L",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.settings",
    label: "Settings",
    description: "Navigate to the Settings panel",
    defaultAccelerator: "CmdOrCtrl+Shift+S",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.chat",
    label: "Chat & Sessions",
    description: "Navigate to the Chat / Sessions panel",
    defaultAccelerator: "CmdOrCtrl+Shift+C",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.workflows",
    label: "Workflows",
    description: "Navigate to the Workflows panel",
    defaultAccelerator: "CmdOrCtrl+Shift+W",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.fleet",
    label: "Fleet Sessions",
    description: "Navigate to the Fleet Sessions panel",
    defaultAccelerator: "CmdOrCtrl+Shift+F",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.control",
    label: "Control Panel",
    description: "Navigate to the Control Panel",
    defaultAccelerator: "CmdOrCtrl+Shift+O",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.infra",
    label: "Infrastructure",
    description: "Navigate to the Infrastructure panel",
    defaultAccelerator: "CmdOrCtrl+Shift+I",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.library",
    label: "Library",
    description: "Navigate to the Library panel",
    defaultAccelerator: "CmdOrCtrl+Shift+B",
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.navigate.telemetry",
    label: "Telemetry",
    description: "Navigate to the Telemetry panel",
    defaultAccelerator: null,
    scope: SCOPE_LOCAL,
    group: "Navigation",
  },
  {
    id: "bosun.show.shortcuts",
    label: "Show Keyboard Shortcuts",
    description: "Display a reference sheet of all keyboard shortcuts",
    defaultAccelerator: "CmdOrCtrl+/",
    scope: SCOPE_LOCAL,
    group: "Help",
  },
];

// ── Module state ─────────────────────────────────────────────────────────────

/** @type {Map<string, () => void>} */
const actionHandlers = new Map();

/**
 * User customizations: Map<id, accelerator | null>.
 * null = explicitly disabled.
 */
let customizations = new Map();

/** Path to the JSON config file. */
let configFilePath = null;

/** Whether global shortcuts are currently registered. */
let globalsActive = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the shortcuts manager.
 * Must be called before registerGlobalShortcuts().
 *
 * @param {string} configDir  The bosun config directory path.
 */
export function initShortcuts(configDir) {
  configFilePath = resolve(configDir, "desktop-shortcuts.json");
  customizations = _loadCustomizations(configFilePath);
}

/**
 * Register a callback for a shortcut action.
 * Handlers should be registered before calling registerGlobalShortcuts().
 *
 * @param {string}    id       Shortcut ID from DEFAULT_SHORTCUTS.
 * @param {() => void} handler Function to invoke when the shortcut fires.
 */
export function onShortcut(id, handler) {
  actionHandlers.set(id, handler);
}

/**
 * Register all SCOPE_GLOBAL shortcuts with Electron.
 * Silently skips shortcuts that have no registered action handler.
 * Safe to call multiple times — old registrations are cleared first.
 */
export function registerGlobalShortcuts() {
  // Unregister all previously registered globals cleanly.
  _unregisterAllGlobals();

  for (const def of DEFAULT_SHORTCUTS) {
    if (def.scope !== SCOPE_GLOBAL) continue;

    const accelerator = getEffectiveAccelerator(def.id);
    if (!accelerator) continue; // disabled by user

    const handler = actionHandlers.get(def.id);
    if (!handler) continue; // no action wired yet

    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) {
        console.warn(
          `[shortcuts] global shortcut already in use: ${accelerator} (${def.id})`,
        );
      }
    } catch (err) {
      console.warn(
        `[shortcuts] failed to register ${accelerator} (${def.id}):`,
        err?.message || err,
      );
    }
  }

  globalsActive = true;
}

/**
 * Unregister all global shortcuts managed by this module.
 * Called during app shutdown.
 */
export function unregisterGlobalShortcuts() {
  _unregisterAllGlobals();
  globalsActive = false;
}

/**
 * Return the complete shortcuts list merged with user customizations.
 * This is the payload delivered over IPC to the settings UI.
 *
 * @returns {Array<ShortcutDef & { accelerator: string|null, isCustomized: boolean, isDisabled: boolean }>}
 */
export function getAllShortcuts() {
  return DEFAULT_SHORTCUTS.map((def) => {
    const hasOverride = customizations.has(def.id);
    const overrideValue = customizations.get(def.id);
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      defaultAccelerator: def.defaultAccelerator,
      accelerator: hasOverride
        ? (overrideValue ?? null)
        : def.defaultAccelerator,
      scope: def.scope,
      group: def.group ?? "",
      isCustomized: hasOverride && overrideValue !== undefined,
      isDisabled: hasOverride && overrideValue === null,
    };
  });
}

/**
 * Get the effective (possibly customized) accelerator for a shortcut.
 * Returns null if the shortcut has been explicitly disabled.
 *
 * @param   {string}      id
 * @returns {string|null}
 */
export function getEffectiveAccelerator(id) {
  if (customizations.has(id)) {
    const v = customizations.get(id);
    return v === null ? null : v;
  }
  return DEFAULT_SHORTCUTS.find((d) => d.id === id)?.defaultAccelerator ?? null;
}

/**
 * Set a custom accelerator for a shortcut.
 * Pass `null` to disable the shortcut entirely.
 * Automatically re-registers global shortcuts when needed.
 *
 * @param   {string}      id
 * @param   {string|null} accelerator  Electron accelerator string, or null to disable.
 * @returns {{ ok: boolean, error?: string }}
 */
export function setShortcut(id, accelerator) {
  const def = DEFAULT_SHORTCUTS.find((d) => d.id === id);
  if (!def) return { ok: false, error: `Unknown shortcut: ${id}` };

  if (accelerator !== null && accelerator !== undefined) {
    // Reject empty strings
    if (!String(accelerator).trim()) {
      return { ok: false, error: "Accelerator must not be empty. Pass null to disable." };
    }
    // Conflict check — only among shortcuts of the same scope
    const conflict = _findConflict(id, accelerator, def.scope);
    if (conflict) {
      return {
        ok: false,
        error: `'${accelerator}' is already used by '${conflict}'`,
      };
    }
  }

  customizations.set(id, accelerator === undefined ? null : accelerator);
  _saveCustomizations(configFilePath, customizations);

  // Re-apply globals when a global shortcut is changed.
  if (def.scope === SCOPE_GLOBAL && globalsActive) {
    registerGlobalShortcuts();
  }

  return { ok: true };
}

/**
 * Reset a shortcut to its default accelerator.
 *
 * @param   {string} id
 * @returns {{ ok: boolean }}
 */
export function resetShortcut(id) {
  const def = DEFAULT_SHORTCUTS.find((d) => d.id === id);
  if (!def) return { ok: false, error: `Unknown shortcut: ${id}` };

  customizations.delete(id);
  _saveCustomizations(configFilePath, customizations);

  if (def.scope === SCOPE_GLOBAL && globalsActive) {
    registerGlobalShortcuts();
  }

  return { ok: true };
}

/**
 * Reset ALL shortcuts to their defaults.
 *
 * @returns {{ ok: boolean }}
 */
export function resetAllShortcuts() {
  customizations.clear();
  _saveCustomizations(configFilePath, customizations);

  if (globalsActive) registerGlobalShortcuts();
  return { ok: true };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _unregisterAllGlobals() {
  for (const def of DEFAULT_SHORTCUTS) {
    if (def.scope !== SCOPE_GLOBAL) continue;

    // Unregister both the currently effective AND the default to be safe
    // when an override is being replaced.
    const current = getEffectiveAccelerator(def.id);
    const fallback = def.defaultAccelerator;

    for (const acc of new Set([current, fallback])) {
      if (acc) {
        try {
          globalShortcut.unregister(acc);
        } catch {
          /* best effort */
        }
      }
    }
  }
}

/**
 * Find the label of a shortcut in the same scope that already uses `accelerator`.
 * Returns null if there is no conflict.
 *
 * @param {string} excludeId
 * @param {string} accelerator
 * @param {string} scope
 * @returns {string|null}
 */
function _findConflict(excludeId, accelerator, scope) {
  const normalized = _normalizeAcc(accelerator);
  for (const def of DEFAULT_SHORTCUTS) {
    if (def.id === excludeId) continue;
    if (def.scope !== scope) continue;
    const eff = getEffectiveAccelerator(def.id);
    if (eff && _normalizeAcc(eff) === normalized) {
      return def.label;
    }
  }
  return null;
}

function _normalizeAcc(acc) {
  return String(acc).toLowerCase().replace(/\s+/g, "");
}

function _loadCustomizations(filePath) {
  try {
    if (!existsSync(filePath)) return new Map();
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
    return new Map(
      Object.entries(raw).map(([k, v]) => [k, v === null ? null : String(v)]),
    );
  } catch {
    return new Map();
  }
}

function _saveCustomizations(filePath, map) {
  if (!filePath) return;
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(map);
    writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.warn("[shortcuts] failed to save:", err?.message || err);
  }
}
