/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Router / Tab Navigation
 *  Manages active tab, history stack, and Telegram BackButton
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { haptic, showBackButton, hideBackButton } from "./telegram.js";
import { refreshTab } from "./state.js";

/** Currently active tab ID */
export const activeTab = signal("dashboard");

/** Navigation history stack (for back button) */
const tabHistory = [];

/**
 * Navigate to a new tab. Pushes current tab onto the history stack
 * and refreshes data for the target tab.
 * @param {string} tab
 * @param {{ resetHistory?: boolean, forceRefresh?: boolean }} [opts]
 */
export function navigateTo(tab, opts = {}) {
  const { resetHistory = false, forceRefresh = false } = opts;
  const goingHome = tab === "dashboard";
  const shouldReset = resetHistory || goingHome;

  if (tab === activeTab.value) {
    if (forceRefresh) refreshTab(tab, { force: true });
    if (shouldReset) {
      tabHistory.length = 0;
      hideBackButton();
    }
    return;
  }

  haptic("light");
  if (shouldReset) {
    tabHistory.length = 0;
  } else {
    tabHistory.push(activeTab.value);
  }
  activeTab.value = tab;
  refreshTab(tab, forceRefresh ? { force: true } : undefined);

  // Show Telegram BackButton when there is history
  if (tabHistory.length > 0) {
    showBackButton(goBack);
  } else {
    hideBackButton();
  }
}

/**
 * Go back to the previous tab (from history stack).
 */
export function goBack() {
  const prev = tabHistory.pop();
  if (prev) {
    haptic("light");
    activeTab.value = prev;
    refreshTab(prev);
  }
  if (tabHistory.length === 0) {
    hideBackButton();
  }
}

/**
 * Ordered list of tabs with metadata for rendering the navigation UI.
 * The `icon` key maps to a property on the ICONS object in modules/icons.js.
 */
export const TAB_CONFIG = [
  { id: "dashboard", label: "Home", icon: "grid" },
  { id: "tasks", label: "Tasks", icon: "check" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "agents", label: "Agents", icon: "cpu" },
  { id: "infra", label: "Infra", icon: "server" },
  { id: "control", label: "Control", icon: "sliders" },
  { id: "logs", label: "Logs", icon: "terminal" },
  { id: "settings", label: "Settings", icon: "settings" },
];
