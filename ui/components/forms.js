/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Form / Control Components
 *  SegmentedControl, Collapsible, PullToRefresh, SearchInput,
 *  Toggle, Stepper, SliderControl
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useRef,
  useCallback,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { ICONS } from "../modules/icons.js";
import { haptic } from "../modules/telegram.js";

/* ═══════════════════════════════════════════════
 *  SegmentedControl
 * ═══════════════════════════════════════════════ */

/**
 * Pill-shaped segmented control.
 * @param {{options: Array<{value: string, label: string}>, value: string, onChange: (v: string) => void}} props
 */
export function SegmentedControl({ options = [], value, onChange, disabled = false }) {
  return html`
    <div class="segmented-control ${disabled ? "disabled" : ""}">
      ${options.map(
        (opt) => html`
          <button
            key=${opt.value}
            class="segmented-btn ${value === opt.value ? "active" : ""}"
            disabled=${disabled}
            onClick=${() => {
              if (disabled) return;
              haptic("light");
              onChange(opt.value);
            }}
          >
            ${opt.label}
          </button>
        `,
      )}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Collapsible
 * ═══════════════════════════════════════════════ */

/**
 * Expandable section with chevron rotation animation.
 * @param {{title: string, defaultOpen?: boolean, children?: any}} props
 */
export function Collapsible({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return html`
    <div class="collapsible">
      <button
        class="collapsible-header ${open ? "open" : ""}"
        onClick=${() => {
          haptic("light");
          setOpen(!open);
        }}
      >
        <span class="collapsible-title">${title}</span>
        <span class="collapsible-chevron ${open ? "open" : ""}">
          ${ICONS.chevronDown}
        </span>
      </button>
      <div class="collapsible-body ${open ? "open" : ""}">${children}</div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  PullToRefresh
 * ═══════════════════════════════════════════════ */

/**
 * Wraps content with pull-to-refresh gesture detection.
 * Shows a spinner while refreshing.
 * @param {{onRefresh: () => Promise<void>, children?: any}} props
 */
export function PullToRefresh({ onRefresh, children }) {
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const containerRef = useRef(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);

  const THRESHOLD = 64;

  const handleTouchStart = useCallback((e) => {
    if (containerRef.current && containerRef.current.scrollTop <= 0) {
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
    }
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (!pullingRef.current) return;
    const diff = e.touches[0].clientY - startYRef.current;
    if (diff > 0) {
      // Apply diminishing returns to pull distance
      setPullDistance(Math.min(diff * 0.4, THRESHOLD * 1.5));
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!pullingRef.current) return;
    pullingRef.current = false;

    if (pullDistance >= THRESHOLD) {
      setRefreshing(true);
      haptic("medium");
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
    setPullDistance(0);
  }, [onRefresh, pullDistance]);

  return html`
    <div
      ref=${containerRef}
      class="pull-to-refresh-container"
      onTouchStart=${handleTouchStart}
      onTouchMove=${handleTouchMove}
      onTouchEnd=${handleTouchEnd}
    >
      ${(refreshing || pullDistance > 0) &&
      html`
        <div
          class="ptr-indicator"
          style="height: ${refreshing ? THRESHOLD : pullDistance}px;
            display:flex;align-items:center;justify-content:center;
            transition: ${pullingRef.current ? "none" : "height 0.2s ease"}"
        >
          <div
            class="ptr-spinner-icon ${refreshing ? "spinning" : ""}"
            style="transform: rotate(${pullDistance * 4}deg);
              opacity: ${Math.min(1, pullDistance / THRESHOLD)}"
          >
            ${ICONS.refresh}
          </div>
        </div>
      `}
      ${children}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  SearchInput
 * ═══════════════════════════════════════════════ */

/**
 * Search input with magnifying glass icon and clear button.
 * @param {{value: string, onInput: (e: Event) => void, placeholder?: string, onClear?: () => void}} props
 */
export function SearchInput({
  value = "",
  onInput,
  placeholder = "Search…",
  onClear,
  disabled = false,
  inputRef,
}) {
  return html`
    <div class="search-input-wrap ${disabled ? "disabled" : ""}">
      <span class="search-input-icon">${ICONS.search}</span>
      <input
        ref=${inputRef}
        class="input search-input"
        type="text"
        placeholder=${placeholder}
        value=${value}
        onInput=${onInput}
        disabled=${disabled}
      />
      ${value && !disabled
        ? html`
            <button
              class="search-input-clear"
              onClick=${() => {
                if (onClear) onClear();
              }}
            >
              ${ICONS.close}
            </button>
          `
        : null}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Toggle
 * ═══════════════════════════════════════════════ */

/**
 * iOS-style toggle switch.
 * @param {{checked: boolean, onChange: (checked: boolean) => void, label?: string}} props
 */
export function Toggle({ checked = false, onChange, label, disabled = false }) {
  const handleClick = () => {
    if (disabled) return;
    haptic("light");
    onChange(!checked);
  };

  return html`
    <div class="toggle-wrap ${disabled ? "disabled" : ""}" onClick=${handleClick}>
      ${label ? html`<span class="toggle-label">${label}</span>` : null}
      <div class="toggle ${checked ? "toggle-on" : ""} ${disabled ? "disabled" : ""}">
        <div class="toggle-thumb"></div>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Stepper
 * ═══════════════════════════════════════════════ */

/**
 * Numeric stepper with − and + buttons.
 * @param {{value: number, min?: number, max?: number, step?: number, onChange: (v: number) => void, label?: string}} props
 */
export function Stepper({
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  disabled = false,
}) {
  const decrement = () => {
    if (disabled) return;
    const next = Math.max(min, value - step);
    if (next !== value) {
      haptic("light");
      onChange(next);
    }
  };
  const increment = () => {
    if (disabled) return;
    const next = Math.min(max, value + step);
    if (next !== value) {
      haptic("light");
      onChange(next);
    }
  };

  return html`
    <div class="stepper-wrap ${disabled ? "disabled" : ""}">
      ${label ? html`<span class="stepper-label">${label}</span>` : null}
      <div class="stepper ${disabled ? "disabled" : ""}">
        <button
          class="stepper-btn"
          onClick=${decrement}
          disabled=${disabled || value <= min}
        >
          −
        </button>
        <span class="stepper-value">${value}</span>
        <button
          class="stepper-btn"
          onClick=${increment}
          disabled=${disabled || value >= max}
        >
          +
        </button>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  SliderControl
 * ═══════════════════════════════════════════════ */

/**
 * Range slider with value display pill.
 * @param {{value: number, min?: number, max?: number, step?: number, onChange: (v: number) => void, label?: string, suffix?: string}} props
 */
export function SliderControl({
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  suffix = "",
}) {
  return html`
    <div class="slider-control">
      ${label
        ? html`<div class="slider-control-header">
            <span class="slider-control-label">${label}</span>
            <span class="pill">${value}${suffix}</span>
          </div>`
        : null}
      <div class="slider-control-row">
        <input
          type="range"
          class="slider-input"
          min=${min}
          max=${max}
          step=${step}
          value=${value}
          onInput=${(e) => onChange(Number(e.target.value))}
        />
        ${!label ? html`<span class="pill">${value}${suffix}</span>` : null}
      </div>
    </div>
  `;
}
