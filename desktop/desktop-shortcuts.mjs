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
 * @property {boolean} [globalEligible]   If true the user can opt this local shortcut in as a global one.
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
    description:
      "Open the voice companion and start a voice call. " +
      "Only fires when Bosun is focused unless 'Enable as global shortcut' is on.",
    defaultAccelerator: "CmdOrCtrl+Shift+Space",
    scope: SCOPE_LOCAL,
    globalEligible: true,
    group: "Voice",
  },
  {
    id: "bosun.voice.video",
    label: "Start Video Call",
    description:
      "Open the voice companion and start a video call. " +
      "Only fires when Bosun is focused unless 'Enable as global shortcut' is on.",
    defaultAccelerator: "CmdOrCtrl+Shift+K",
    scope: SCOPE_LOCAL,
    globalEligible: true,
    group: "Voice",
  },
  {
    id: "bosun.voice.toggle",
    label: "Toggle Voice Companion",
    description:
      "Show or hide the floating voice companion window. " +
      "Only fires when Bosun is focused unless 'Enable as global shortcut' is on.",
    defaultAccelerator: "CmdOrCtrl+Shift+V",
    scope: SCOPE_LOCAL,
    globalEligible: true,
    group: "Voice",
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

/**
 * Per-shortcut global-scope overrides for globalEligible shortcuts.
 * Map<id, boolean> — true = user has opted this local shortcut in as global.
 */
let scopeOverrides = new Map();

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
  const loaded = _loadPersisted(configFilePath);
  customizations = loaded.customizations;
  scopeOverrides = loaded.scopeOverrides;
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
 * Return true when a shortcut should currently be registered as a global.
 * A shortcut qualifies if:
 *  - Its catalog scope is SCOPE_GLOBAL, OR
 *  - It is globalEligible AND the user has opted it in via setShortcutScope().
 *
 * @param {ShortcutDef} def
 * @returns {boolean}
 */
function _isRegisteredGlobal(def) {
  if (def.scope === SCOPE_GLOBAL) return true;
  if (def.globalEligible && scopeOverrides.get(def.id) === true) return true;
  return false;
}

/**
 * Register all global shortcuts with Electron.
 * Includes catalog-scope SCOPE_GLOBAL entries + any globalEligible shortcuts
 * that the user has opted in to fire system-wide.
 * Silently skips shortcuts that have no registered action handler.
 * Safe to call multiple times — old registrations are cleared first.
 */
export function registerGlobalShortcuts() {
  // Unregister all previously registered globals cleanly.
  _unregisterAllGlobals();

  for (const def of DEFAULT_SHORTCUTS) {
    if (!_isRegisteredGlobal(def)) continue;

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
      /** Whether this shortcut can be opted in as a system-wide global. */
      globalEligible: def.globalEligible ?? false,
      /**
       * Whether this globalEligible shortcut is currently firing system-wide.
       * Always true for catalog-scope SCOPE_GLOBAL shortcuts.
       */
      isGlobalEnabled:
        def.scope === SCOPE_GLOBAL ||
        (def.globalEligible === true && scopeOverrides.get(def.id) === true),
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
/**
 * Enable or disable global (system-wide) firing for a globalEligible shortcut.
 * Has no effect on shortcuts that are catalog-level SCOPE_GLOBAL.
 *
 * @param   {string}  id
 * @param   {boolean} isGlobal
 * @returns {{ ok: boolean, error?: string }}
 */
export function setShortcutScope(id, isGlobal) {
  const def = DEFAULT_SHORTCUTS.find((d) => d.id === id);
  if (!def) return { ok: false, error: `Unknown shortcut: ${id}` };
  if (!def.globalEligible) {
    return { ok: false, error: `Shortcut '${id}' does not support scope override.` };
  }

  if (isGlobal) {
    scopeOverrides.set(id, true);
  } else {
    scopeOverrides.delete(id);
  }

  _savePersisted(configFilePath, customizations, scopeOverrides);

  // Re-apply so the shortcut is registered / unregistered immediately.
  if (globalsActive) registerGlobalShortcuts();

  return { ok: true };
}

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
  _savePersisted(configFilePath, customizations, scopeOverrides);

  // Re-apply globals when a global/globally-enabled shortcut is changed.
  if (_isRegisteredGlobal(def) && globalsActive) {
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
  _savePersisted(configFilePath, customizations, scopeOverrides);

  if (_isRegisteredGlobal(def) && globalsActive) {
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
  scopeOverrides.clear();
  _savePersisted(configFilePath, customizations, scopeOverrides);

  if (globalsActive) registerGlobalShortcuts();
  return { ok: true };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _unregisterAllGlobals() {
  for (const def of DEFAULT_SHORTCUTS) {
    // Unregister any shortcut that was or could be registered as global.
    // This covers catalog-level globals AND globalEligible shortcuts regardless
    // of the current scopeOverride value (handles transitions cleanly).
    if (def.scope !== SCOPE_GLOBAL && !def.globalEligible) continue;

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

/**
 * Load both accelerator customizations and scope overrides from disk.
 * File format:
 * {
 *   "shortcut.id": "Accelerator" | null,
 *   "_scopes": { "shortcut.id": true }
 * }
 * The "_scopes" key is reserved and never treated as a shortcut ID.
 *
 * @param {string} filePath
 * @returns {{ customizations: Map<string, string|null>, scopeOverrides: Map<string, boolean> }}
 */
function _loadPersisted(filePath) {
  try {
    if (!existsSync(filePath)) {
      return { customizations: new Map(), scopeOverrides: new Map() };
    }
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { customizations: new Map(), scopeOverrides: new Map() };
    }

    const scopesRaw = raw._scopes;
    const scopeOverridesMap = new Map(
      scopesRaw && typeof scopesRaw === "object" && !Array.isArray(scopesRaw)
        ? Object.entries(scopesRaw)
            .filter(([, v]) => v === true)
            .map(([k]) => [k, true])
        : [],
    );

    const customizationsMap = new Map(
      Object.entries(raw)
        .filter(([k]) => k !== "_scopes")
        .map(([k, v]) => [k, v === null ? null : String(v)]),
    );

    return { customizations: customizationsMap, scopeOverrides: scopeOverridesMap };
  } catch {
    return { customizations: new Map(), scopeOverrides: new Map() };
  }
}

/**
 * Persist both accelerator customizations and scope overrides to disk.
 *
 * @param {string|null}             filePath
 * @param {Map<string, string|null>} customizationsMap
 * @param {Map<string, boolean>}     scopeOverridesMap
 */
function _savePersisted(filePath, customizationsMap, scopeOverridesMap) {
  if (!filePath) return;
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(customizationsMap);
    if (scopeOverridesMap.size > 0) {
      obj._scopes = Object.fromEntries(scopeOverridesMap);
    }
    writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.warn("[shortcuts] failed to save:", err?.message || err);
  }
}
