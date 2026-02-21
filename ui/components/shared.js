/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Shared UI Components
 *  Card, Badge, StatCard, Modal, Toast, EmptyState, etc.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { ICONS } from "../modules/icons.js";
import { toasts, showToast, shouldShowToast } from "../modules/state.js";
import {
  haptic,
  showBackButton,
  hideBackButton,
  getTg,
} from "../modules/telegram.js";
import { classNames } from "../modules/utils.js";

/* ═══════════════════════════════════════════════
 *  Card
 * ═══════════════════════════════════════════════ */

/**
 * Card container with optional title / subtitle.
 * @param {{title?: string, subtitle?: string, children?: any, className?: string, onClick?: () => void}} props
 */
export function Card({ title, subtitle, children, className = "", onClick }) {
  return html`
    <div class="card bg-base-200 shadow-md ${className}" onClick=${onClick}>
      <div class="card-body">
        ${title ? html`<h3 class="card-title text-sm">${title}</h3>` : null}
        ${subtitle ? html`<div class="text-xs text-base-content/60">${subtitle}</div>` : null}
        ${children}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Badge
 * ═══════════════════════════════════════════════ */

const BADGE_VARIANT_MAP = {
  done: "badge-success",
  success: "badge-success",
  error: "badge-error",
  critical: "badge-error",
  inprogress: "badge-info",
  busy: "badge-info",
  running: "badge-info",
  inreview: "badge-warning",
  warning: "badge-warning",
  todo: "badge-ghost",
  idle: "badge-ghost",
  low: "badge-ghost",
  high: "badge-warning",
  medium: "badge-info",
  cancelled: "badge-ghost opacity-50",
  draft: "badge-ghost",
  log: "badge-ghost",
  info: "badge-info",
};

/**
 * Status badge pill.
 * @param {{status?: string, text?: string, className?: string}} props
 */
export function Badge({ status, text, className = "" }) {
  const label = text || status || "";
  const normalized = (status || "").toLowerCase().replace(/\s+/g, "");
  const variant = BADGE_VARIANT_MAP[normalized] || "";
  return html`<span class="badge ${variant} ${className}">${label}</span>`;
}

/* ═══════════════════════════════════════════════
 *  StatCard
 * ═══════════════════════════════════════════════ */

/**
 * Stat display card with large value and small label.
 * @param {{value: any, label: string, trend?: 'up'|'down', color?: string}} props
 */
export function StatCard({ value, label, trend, color }) {
  const valueStyle = color ? `color: ${color}` : "";
  const trendIcon =
    trend === "up"
      ? html`<span class="text-success ml-1">↑</span>`
      : trend === "down"
        ? html`<span class="text-error ml-1">↓</span>`
        : null;

  return html`
    <div class="stat bg-base-200 rounded-box">
      <div class="stat-value" style=${valueStyle}>
        ${value ?? "—"}${trendIcon}
      </div>
      <div class="stat-desc">${label}</div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  SkeletonCard
 * ═══════════════════════════════════════════════ */

/**
 * Animated loading placeholder.
 * @param {{height?: string, className?: string}} props
 */
export function SkeletonCard({ height = "80px", className = "" }) {
  return html`
    <div
      class="skeleton rounded-box ${className}"
      style="height: ${height}"
    ></div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Modal (Bottom Sheet)
 * ═══════════════════════════════════════════════ */

/**
 * Bottom-sheet modal with drag handle, title, swipe-to-dismiss, and TG BackButton integration.
 * @param {{title?: string, open?: boolean, onClose: () => void, children?: any, contentClassName?: string}} props
 */
export function Modal({ title, open = true, onClose, children, contentClassName = "", footer }) {
  const [visible, setVisible] = useState(false);
  const contentRef = useRef(null);
  const dragState = useRef({ startY: 0, startRect: 0, dragging: false });
  const [dragY, setDragY] = useState(0);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(open));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  // Escape key to close (desktop support)
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // BackButton integration
  useEffect(() => {
    const tg = getTg();
    if (!tg?.BackButton) return;

    const handler = () => {
      onClose();
      tg.BackButton.hide();
      tg.BackButton.offClick(handler);
    };
    tg.BackButton.show();
    tg.BackButton.onClick(handler);

    return () => {
      tg.BackButton.hide();
      tg.BackButton.offClick(handler);
    };
  }, [onClose]);

  // Prevent body scroll while dragging
  useEffect(() => {
    if (dragState.current.dragging) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  });

  // Visual viewport (software keyboard) awareness
  // Sets --keyboard-height on :root so the modal can lift above the keyboard
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // keyboard height = amount the visual viewport has shrunk from the layout viewport
      const kh = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--keyboard-height", `${kh}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.setProperty("--keyboard-height", "0px");
    };
  }, [open]);

  // Prevent touches on the scrollable body from triggering swipe-to-dismiss
  const handleBodyTouchStart = useCallback((e) => {
    e.stopPropagation();
  }, []);

  const handleTouchStart = useCallback((e) => {
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    // Only start drag if touch is within top 60px of the modal content
    if (touchY - rect.top > 60) return;
    dragState.current = { startY: touchY, startRect: rect.top, dragging: true };
    // Disable transition during active drag
    el.style.transition = "none";
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (!dragState.current.dragging) return;
    const deltaY = e.touches[0].clientY - dragState.current.startY;
    if (deltaY < 0) {
      setDragY(0);
      return;
    }
    // Diminishing returns past 100px
    const translated = deltaY <= 100 ? deltaY : 100 + (deltaY - 100) * 0.3;
    setDragY(translated);
    e.preventDefault();
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    const el = contentRef.current;
    if (el) el.style.transition = "";
    if (dragY > 150) {
      getTg()?.HapticFeedback?.impactOccurred("light");
      onClose();
    }
    setDragY(0);
  }, [dragY, onClose]);

  const handlePointerDown = useCallback((e) => {
    if (e.pointerType === "touch") return;
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientY - rect.top > 60) return;
    dragState.current = {
      startY: e.clientY,
      startRect: rect.top,
      dragging: true,
      pointerId: e.pointerId,
    };
    el.style.transition = "none";
    try { el.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!dragState.current.dragging) return;
    if (dragState.current.pointerId !== e.pointerId) return;
    const deltaY = e.clientY - dragState.current.startY;
    if (deltaY < 0) {
      setDragY(0);
      return;
    }
    const translated = deltaY <= 100 ? deltaY : 100 + (deltaY - 100) * 0.3;
    setDragY(translated);
    e.preventDefault();
  }, []);

  const handlePointerEnd = useCallback((e) => {
    if (!dragState.current.dragging) return;
    if (dragState.current.pointerId !== e.pointerId) return;
    dragState.current.dragging = false;
    dragState.current.pointerId = null;
    const el = contentRef.current;
    if (el) {
      el.style.transition = "";
      try { el.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    }
    if (dragY > 150) {
      getTg()?.HapticFeedback?.impactOccurred("light");
      onClose();
    }
    setDragY(0);
  }, [dragY, onClose]);

  const handlePointerCancel = useCallback((e) => {
    if (!dragState.current.dragging) return;
    if (dragState.current.pointerId !== e.pointerId) return;
    dragState.current.dragging = false;
    dragState.current.pointerId = null;
    const el = contentRef.current;
    if (el) {
      el.style.transition = "";
      try { el.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    }
    setDragY(0);
  }, []);

  const handleTouchCancel = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    const el = contentRef.current;
    if (el) el.style.transition = "";
    setDragY(0);
  }, []);

  if (!open) return null;

  const dragStyle = dragY > 0
    ? `transform: translateY(${dragY}px); opacity: ${Math.max(0.2, 1 - dragY / 400)}`
    : "";

  return html`
    <div
      class="modal modal-open modal-overlay ${visible ? "modal-overlay-visible" : ""}"
      onClick=${(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref=${contentRef}
        class="modal-box modal-content ${contentClassName} ${visible ? "modal-content-visible" : ""} ${dragY > 0 ? "modal-dragging" : ""}"
        style=${dragStyle}
        onClick=${(e) => e.stopPropagation()}
        onTouchStart=${handleTouchStart}
        onTouchMove=${handleTouchMove}
        onTouchEnd=${handleTouchEnd}
        onTouchCancel=${handleTouchCancel}
        onPointerDown=${handlePointerDown}
        onPointerMove=${handlePointerMove}
        onPointerUp=${handlePointerEnd}
        onPointerCancel=${handlePointerCancel}
      >
        <div class="modal-header flex items-center justify-between p-4">
          <div class="modal-handle"></div>
          ${title ? html`<div class="modal-title font-bold text-lg">${title}</div>` : null}
          <button class="btn btn-sm btn-circle btn-ghost modal-close-btn" onClick=${onClose} aria-label="Close">
            ${ICONS.close}
          </button>
        </div>
        <div class="modal-body p-4 overflow-y-auto" onTouchStart=${handleBodyTouchStart}>
          ${children}
        </div>
        ${footer ? html`<div class="modal-footer p-4">${footer}</div>` : null}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  ConfirmDialog
 * ═══════════════════════════════════════════════ */

/**
 * Confirmation dialog — tries Telegram native showConfirm first, falls back to styled modal.
 * @param {{title?: string, message: string, confirmText?: string, cancelText?: string, onConfirm: () => void, onCancel: () => void, destructive?: boolean}} props
 */
export function ConfirmDialog({
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  destructive = false,
}) {
  const [tried, setTried] = useState(false);

  // Escape key to cancel (desktop support)
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape' && onCancel) onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Try Telegram native confirm first
  useEffect(() => {
    const tg = getTg();
    if (tg?.showConfirm && !tried) {
      setTried(true);
      tg.showConfirm(message, (ok) => {
        if (ok) onConfirm();
        else onCancel();
      });
    }
  }, [message, onConfirm, onCancel, tried]);

  // If Telegram native is available, render nothing (native dialog handles it)
  if (getTg()?.showConfirm) return null;

  return html`
    <div class="modal modal-open">
      <div
        class="modal-box"
        onClick=${(e) => e.stopPropagation()}
      >
        <h3 class="font-bold text-lg">${title}</h3>
        <p class="py-4">${message}</p>
        <div class="modal-action">
          <button class="btn" onClick=${onCancel}>
            ${cancelText}
          </button>
          <button
            class="btn btn-primary ${destructive ? "btn-error" : ""}"
            onClick=${onConfirm}
          >
            ${confirmText}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" onClick=${onCancel}></div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  confirmAction (Promise-based utility)
 * ═══════════════════════════════════════════════ */

/**
 * Quick inline confirmation — returns a Promise<boolean>.
 * Uses Telegram native confirm if available, otherwise browser confirm().
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function confirmAction(message) {
  const tg = getTg();
  if (tg?.showConfirm) {
    return new Promise((resolve) => tg.showConfirm(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/* ═══════════════════════════════════════════════
 *  Spinner
 * ═══════════════════════════════════════════════ */

/**
 * Inline SVG spinner for loading indicators.
 * @param {{size?: number, color?: string}} props
 */
export function Spinner({ size = 16, color = "currentColor" }) {
  return html`<svg class="spinner" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke=${color} stroke-width="2.5" stroke-linecap="round">
    <circle cx="12" cy="12" r="10" opacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" />
  </svg>`;
}

/* ═══════════════════════════════════════════════
 *  LoadingButton
 * ═══════════════════════════════════════════════ */

/**
 * Button that shows a spinner when loading.
 * @param {{loading?: boolean, onClick?: () => void, children?: any, class?: string, disabled?: boolean}} props
 */
export function LoadingButton({ loading = false, onClick, children, class: cls = "", disabled = false, ...rest }) {
  return html`<button
    class=${`btn ${cls} ${loading ? "loading loading-spinner" : ""}`}
    onClick=${!loading && !disabled ? onClick : undefined}
    disabled=${loading || disabled}
    ...${rest}
  >${loading ? html`<${Spinner} size=${14} /> ` : ""}${children}</button>`;
}

/* ═══════════════════════════════════════════════
 *  Toast / ToastContainer
 * ═══════════════════════════════════════════════ */

/**
 * Renders all active toasts from the toasts signal.
 * Each toast auto-dismisses (handled by showToast in state.js).
 */
export function ToastContainer() {
  const items = toasts.value;
  if (!items.length) return null;

  const visible = items.filter(shouldShowToast);
  if (!visible.length) return null;

  return html`
    <div class="toast toast-end toast-bottom z-50">
      ${visible.map(
        (t) => html`
          <div key=${t.id} class="alert alert-${t.type === 'error' ? 'error' : t.type === 'success' ? 'success' : t.type === 'warning' ? 'warning' : 'info'} shadow-lg">
            <span>${t.message}</span>
            <button
              class="btn btn-sm btn-ghost"
              onClick=${() => {
                toasts.value = toasts.value.filter((x) => x.id !== t.id);
              }}
            >
              ✕
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  EmptyState
 * ═══════════════════════════════════════════════ */

/**
 * Empty state display.
 * @param {{icon?: string, title?: string, message?: string, description?: string, action?: {label: string, onClick: () => void}}} props
 */
export function EmptyState({ icon, title, message, description, action }) {
  const iconSvg = icon && ICONS[icon] ? ICONS[icon] : null;
  const displayIcon = iconSvg ? html`<div class="text-4xl mb-4 opacity-40">${iconSvg}</div>`
    : icon ? html`<div class="text-4xl mb-4 opacity-40">${icon}</div>`
    : null;
  const displayTitle = title || message || null;
  return html`
    <div class="flex flex-col items-center justify-center py-12 px-4 text-center">
      ${displayIcon}
      ${displayTitle ? html`<div class="text-lg font-semibold text-base-content/70">${displayTitle}</div>` : null}
      ${description
        ? html`<div class="text-sm text-base-content/50 mt-2 max-w-xs">${description}</div>`
        : null}
      ${action
        ? html`<button class="btn btn-primary btn-sm mt-4" onClick=${action.onClick}>
            ${action.label}
          </button>`
        : null}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Divider
 * ═══════════════════════════════════════════════ */

/**
 * Section divider with optional centered label.
 * @param {{label?: string}} props
 */
export function Divider({ label }) {
  return html`<div class="divider">${label || ""}</div>`;
}

/* ═══════════════════════════════════════════════
 *  Avatar
 * ═══════════════════════════════════════════════ */

/**
 * Circle avatar with initials fallback.
 * @param {{name?: string, size?: number, src?: string}} props
 */
export function Avatar({ name = "", size = 36, src }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

  const innerStyle = `width:${size}px;height:${size}px`;

  if (src) {
    return html`
      <div class="avatar placeholder">
        <div class="bg-primary text-primary-content rounded-full" style=${innerStyle}>
          <img
            src=${src}
            alt=${name}
            style="width:100%;height:100%;object-fit:cover"
            onError=${(e) => {
              e.target.style.display = "none";
            }}
          />
        </div>
      </div>
    `;
  }

  return html`
    <div class="avatar placeholder">
      <div class="bg-primary text-primary-content rounded-full" style=${innerStyle}>
        <span style="font-size:${Math.round(size * 0.4)}px">${initials || "?"}</span>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  ListItem
 * ═══════════════════════════════════════════════ */

/**
 * Generic list item for settings-style lists.
 * @param {{title: string, subtitle?: string, trailing?: any, onClick?: () => void, icon?: string}} props
 */
export function ListItem({ title, subtitle, trailing, onClick, icon }) {
  const iconSvg = icon && ICONS[icon] ? ICONS[icon] : null;
  return html`
    <div
      class="flex items-center gap-3 px-4 py-3 rounded-lg ${onClick ? 'hover:bg-base-200 cursor-pointer' : ''} transition-colors"
      onClick=${onClick}
    >
      ${iconSvg ? html`<div class="flex-shrink-0 w-5 h-5 opacity-60">${iconSvg}</div>` : null}
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium truncate">${title}</div>
        ${subtitle
          ? html`<div class="text-xs text-base-content/50 truncate">${subtitle}</div>`
          : null}
      </div>
      ${trailing != null
        ? html`<div class="flex-shrink-0">${trailing}</div>`
        : null}
    </div>
  `;
}
