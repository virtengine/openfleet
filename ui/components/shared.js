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
    <div class="card ${className}" onClick=${onClick}>
      ${title ? html`<div class="card-title">${title}</div>` : null}
      ${subtitle ? html`<div class="card-subtitle">${subtitle}</div>` : null}
      ${children}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Badge
 * ═══════════════════════════════════════════════ */

const BADGE_STATUS_MAP = new Set([
  "draft",
  "todo",
  "inprogress",
  "inreview",
  "done",
  "error",
  "cancelled",
  "critical",
  "high",
  "medium",
  "low",
  "log",
  "info",
  "warning",
]);

/**
 * Status badge pill.
 * @param {{status?: string, text?: string, className?: string}} props
 */
export function Badge({ status, text, className = "" }) {
  const label = text || status || "";
  const normalized = (status || "").toLowerCase().replace(/\s+/g, "");
  const statusClass = BADGE_STATUS_MAP.has(normalized)
    ? `badge-${normalized}`
    : "";
  return html`<span class="badge ${statusClass} ${className}">${label}</span>`;
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
      ? html`<span class="stat-trend stat-trend-up">↑</span>`
      : trend === "down"
        ? html`<span class="stat-trend stat-trend-down">↓</span>`
        : null;

  return html`
    <div class="stat-card">
      <div class="stat-value" style=${valueStyle}>
        ${value ?? "—"}${trendIcon}
      </div>
      <div class="stat-label">${label}</div>
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
      class="skeleton skeleton-card ${className}"
      style="height: ${height}"
    ></div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Modal (Bottom Sheet)
 * ═══════════════════════════════════════════════ */

/**
 * Bottom-sheet modal with drag handle, title, swipe-to-dismiss, and TG BackButton integration.
 * @param {{title?: string, open?: boolean, onClose: () => void, children?: any}} props
 */
export function Modal({ title, open = true, onClose, children }) {
  const [visible, setVisible] = useState(false);
  const contentRef = useRef(null);
  const dragState = useRef({ startY: 0, startRect: 0, dragging: false });
  const [dragY, setDragY] = useState(0);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(open));
  }, [open]);

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
      class="modal-overlay ${visible ? "modal-overlay-visible" : ""}"
      onClick=${(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref=${contentRef}
        class="modal-content ${visible ? "modal-content-visible" : ""} ${dragY > 0 ? "modal-dragging" : ""}"
        style=${dragStyle}
        onClick=${(e) => e.stopPropagation()}
        onTouchStart=${handleTouchStart}
        onTouchMove=${handleTouchMove}
        onTouchEnd=${handleTouchEnd}
        onTouchCancel=${handleTouchCancel}
      >
        <div class="modal-handle"></div>
        ${title ? html`<div class="modal-title">${title}</div>` : null}
        ${children}
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

  const confirmBtnStyle = destructive
    ? "background: var(--destructive); color: #fff;"
    : "";

  return html`
    <div class="modal-overlay modal-overlay-visible" onClick=${onCancel}>
      <div
        class="confirm-dialog"
        onClick=${(e) => e.stopPropagation()}
      >
        <div class="confirm-dialog-title">${title}</div>
        <div class="confirm-dialog-message">${message}</div>
        <div class="confirm-dialog-actions">
          <button class="btn btn-secondary" onClick=${onCancel}>
            ${cancelText}
          </button>
          <button
            class="btn btn-primary ${destructive ? "btn-destructive" : ""}"
            style=${confirmBtnStyle}
            onClick=${onConfirm}
          >
            ${confirmText}
          </button>
        </div>
      </div>
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
    <div class="toast-container">
      ${visible.map(
        (t) => html`
          <div key=${t.id} class="toast toast-${t.type}">
            <span class="toast-message">${t.message}</span>
            <button
              class="toast-close"
              onClick=${() => {
                toasts.value = toasts.value.filter((x) => x.id !== t.id);
              }}
            >
              ×
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
  const displayIcon = iconSvg ? html`<div class="empty-state-icon">${iconSvg}</div>`
    : icon ? html`<div class="empty-state-icon">${icon}</div>`
    : null;
  const displayTitle = title || message || null;
  return html`
    <div class="empty-state">
      ${displayIcon}
      ${displayTitle ? html`<div class="empty-state-title">${displayTitle}</div>` : null}
      ${description
        ? html`<div class="empty-state-description">${description}</div>`
        : null}
      ${action
        ? html`<button class="btn btn-primary btn-sm" onClick=${action.onClick}>
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
  if (!label) return html`<div class="divider"></div>`;
  return html`
    <div class="divider divider-label">
      <span>${label}</span>
    </div>
  `;
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

  const style = `width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;
    display:flex;align-items:center;justify-content:center;
    background:var(--accent,#5b6eae);color:var(--accent-text,#fff);
    font-size:${Math.round(size * 0.4)}px;font-weight:600;flex-shrink:0`;

  if (src) {
    return html`
      <div style=${style}>
        <img
          src=${src}
          alt=${name}
          style="width:100%;height:100%;object-fit:cover"
          onError=${(e) => {
            e.target.style.display = "none";
          }}
        />
      </div>
    `;
  }

  return html`<div style=${style}>${initials || "?"}</div>`;
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
      class=${classNames("list-item", { "list-item-clickable": !!onClick })}
      onClick=${onClick}
    >
      ${iconSvg ? html`<div class="list-item-icon">${iconSvg}</div>` : null}
      <div class="list-item-body">
        <div class="list-item-title">${title}</div>
        ${subtitle
          ? html`<div class="list-item-subtitle">${subtitle}</div>`
          : null}
      </div>
      ${trailing != null
        ? html`<div class="list-item-trailing">${trailing}</div>`
        : null}
    </div>
  `;
}
