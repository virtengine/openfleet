/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Telegram SDK Wrapper
 *  Enhanced Telegram Mini App SDK integration
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";

/* ─── Core Accessor ─── */

/** Get the Telegram WebApp instance, or null outside Telegram */
export function getTg() {
  return globalThis.Telegram?.WebApp || null;
}

/** Whether the app is running inside a Telegram WebView */
export const isTelegramContext = !!getTg();

/** Reactive color scheme signal ('light' | 'dark') */
export const colorScheme = signal(getTg()?.colorScheme || "dark");

/* ─── Haptic Feedback ─── */

/**
 * Trigger haptic feedback.
 * @param {'light'|'medium'|'heavy'|'rigid'|'soft'} type
 */
export function haptic(type = "light") {
  try {
    getTg()?.HapticFeedback?.impactOccurred(type);
  } catch {
    /* noop outside Telegram */
  }
}

/* ─── Initialization ─── */

/**
 * Full Telegram WebApp initialization – call once at app mount.
 * Expands the viewport, enables fullscreen, disables vertical swipes,
 * sets header/background/bottom-bar colors, etc.
 */
export function initTelegramApp() {
  const tg = getTg();
  if (!tg) return;

  tg.ready();
  tg.expand();

  // Bot API 8.0+ fullscreen — only on mobile (desktop Telegram doesn't need it)
  const platform = (tg.platform || "").toLowerCase();
  const isMobile = platform === "ios" || platform === "android" || platform === "android_x";
  if (isMobile) {
    try {
      tg.requestFullscreen?.();
    } catch {
      /* not supported */
    }
  }

  // Bot API 7.7+ disable vertical swipes for custom scroll
  try {
    tg.disableVerticalSwipes?.();
  } catch {
    /* not supported */
  }

  // Closing confirmation
  try {
    tg.enableClosingConfirmation?.();
  } catch {
    /* not supported */
  }

  // Apply colours
  try {
    tg.setHeaderColor?.("secondary_bg_color");
    tg.setBackgroundColor?.("bg_color");
    tg.setBottomBarColor?.("secondary_bg_color");
  } catch {
    /* not supported */
  }

  // Apply theme params to CSS custom properties
  applyTgTheme();
}

/** Map Telegram themeParams to CSS custom properties on :root */
function applyTgTheme() {
  const tg = getTg();
  if (!tg?.themeParams) return;

  const tp = tg.themeParams;
  const root = document.documentElement;
  root.setAttribute("data-tg-theme", "true");

  if (tp.bg_color) root.style.setProperty("--bg-primary", tp.bg_color);
  if (tp.secondary_bg_color) {
    root.style.setProperty("--bg-secondary", tp.secondary_bg_color);
    root.style.setProperty("--bg-card", tp.secondary_bg_color);
  }
  if (tp.text_color) root.style.setProperty("--text-primary", tp.text_color);
  if (tp.hint_color) {
    root.style.setProperty("--text-secondary", tp.hint_color);
    root.style.setProperty("--text-hint", tp.hint_color);
  }
  if (tp.link_color) root.style.setProperty("--accent", tp.link_color);
  if (tp.button_color) root.style.setProperty("--accent", tp.button_color);
  if (tp.button_text_color)
    root.style.setProperty("--accent-text", tp.button_text_color);
}

/* ─── Event Listeners ─── */

/**
 * Subscribe to theme changes. Returns an unsubscribe function.
 * @param {() => void} callback
 * @returns {() => void}
 */
export function onThemeChange(callback) {
  const tg = getTg();
  if (!tg) return () => {};
  const handler = () => {
    applyTgTheme();
    callback();
  };
  tg.onEvent("themeChanged", handler);
  return () => tg.offEvent("themeChanged", handler);
}

/**
 * Subscribe to viewport changes. Returns an unsubscribe function.
 * @param {(event: {isStateStable: boolean}) => void} callback
 * @returns {() => void}
 */
export function onViewportChange(callback) {
  const tg = getTg();
  if (!tg) return () => {};
  tg.onEvent("viewportChanged", callback);
  return () => tg.offEvent("viewportChanged", callback);
}

/* ─── MainButton Helpers ─── */

/**
 * Show the Telegram MainButton with given text and handler.
 * @param {string} text
 * @param {() => void} onClick
 * @param {{color?: string, textColor?: string, progress?: boolean}} options
 */
export function showMainButton(text, onClick, options = {}) {
  const tg = getTg();
  if (!tg?.MainButton) return;
  tg.MainButton.setText(text);
  if (options.color) tg.MainButton.color = options.color;
  if (options.textColor) tg.MainButton.textColor = options.textColor;
  tg.MainButton.onClick(onClick);
  tg.MainButton.show();
  if (options.progress) tg.MainButton.showProgress();
}

/** Hide the Telegram MainButton and clear its handler. */
export function hideMainButton() {
  const tg = getTg();
  if (!tg?.MainButton) return;
  tg.MainButton.hide();
  tg.MainButton.hideProgress();
  try {
    tg.MainButton.offClick(tg.MainButton._callback);
  } catch {
    /* noop */
  }
}

/* ─── BackButton Helpers ─── */

/**
 * Show the Telegram BackButton with the given handler.
 * @param {() => void} onClick
 */
export function showBackButton(onClick) {
  const tg = getTg();
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(onClick);
  tg.BackButton.show();
}

/** Hide the Telegram BackButton and clear its handler. */
export function hideBackButton() {
  const tg = getTg();
  if (!tg?.BackButton) return;
  tg.BackButton.hide();
  try {
    tg.BackButton.offClick(tg.BackButton._callback);
  } catch {
    /* noop */
  }
}

/* ─── SettingsButton ─── */

/**
 * Show the Telegram SettingsButton (header gear icon).
 * @param {() => void} onClick
 */
export function showSettingsButton(onClick) {
  const tg = getTg();
  if (!tg?.SettingsButton) return;
  tg.SettingsButton.onClick(onClick);
  tg.SettingsButton.show();
}

/* ─── Cloud Storage ─── */

/**
 * Read a value from Telegram Cloud Storage.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function cloudStorageGet(key) {
  const tg = getTg();
  if (!tg?.CloudStorage) return null;
  return new Promise((resolve) => {
    tg.CloudStorage.getItem(key, (err, val) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(val ?? null);
    });
  });
}

/**
 * Write a value to Telegram Cloud Storage.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<boolean>}
 */
export async function cloudStorageSet(key, value) {
  const tg = getTg();
  if (!tg?.CloudStorage) return false;
  return new Promise((resolve) => {
    tg.CloudStorage.setItem(key, value, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Remove a key from Telegram Cloud Storage.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function cloudStorageRemove(key) {
  const tg = getTg();
  if (!tg?.CloudStorage) return false;
  return new Promise((resolve) => {
    tg.CloudStorage.removeItem(key, (err) => {
      resolve(!err);
    });
  });
}

/* ─── Auth / User ─── */

/** Get the raw initData string for server-side validation. */
export function getInitData() {
  return getTg()?.initData || "";
}

/** Get the current Telegram user object, or null. */
export function getTelegramUser() {
  return getTg()?.initDataUnsafe?.user || null;
}

/* ─── Native Dialogs ─── */

/**
 * Show a native Telegram confirm dialog (falls back to window.confirm).
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function showConfirm(message) {
  return new Promise((resolve) => {
    const tg = getTg();
    if (!tg?.showConfirm) {
      resolve(window.confirm(message));
      return;
    }
    tg.showConfirm(message, resolve);
  });
}

/**
 * Show a native Telegram alert dialog (falls back to window.alert).
 * @param {string} message
 * @returns {Promise<void>}
 */
export function showAlert(message) {
  return new Promise((resolve) => {
    const tg = getTg();
    if (!tg?.showAlert) {
      window.alert(message);
      resolve();
      return;
    }
    tg.showAlert(message, resolve);
  });
}

/* ─── External Links ─── */

/**
 * Open a URL in the external browser via Telegram, or fallback.
 * @param {string} url
 */
export function openLink(url) {
  const tg = getTg();
  if (tg?.openLink) {
    tg.openLink(url);
    return;
  }
  window.open(url, "_blank");
}

/* ─── Platform ─── */

/** Return the current Telegram platform string (e.g. 'android', 'ios', 'tdesktop'). */
export function getPlatform() {
  return getTg()?.platform || "unknown";
}
