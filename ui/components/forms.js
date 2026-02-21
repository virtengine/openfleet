/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Form / Control Components (DaisyUI 4)
 *  SegmentedControl, Collapsible, PullToRefresh, SearchInput,
 *  Toggle, Stepper, SliderControl, Dropdown, SelectInput, DataTable
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { ICONS } from "../modules/icons.js";
import { haptic } from "../modules/telegram.js";

/* ═══════════════════════════════════════════════
 *  SegmentedControl
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI join-based segmented control.
 * @param {{options: Array<{value: string, label: string}>, value: string, onChange: (v: string) => void, disabled?: boolean}} props
 */
export function SegmentedControl({ options = [], value, onChange, disabled = false }) {
  return html`
    <div class="join">
      ${options.map(
        (opt) => html`
          <button
            key=${opt.value}
            class="join-item btn btn-sm ${value === opt.value ? 'btn-active btn-primary' : ''} ${disabled ? 'btn-disabled' : ''}"
            disabled=${disabled}
            onClick=${() => {
              if (!disabled) {
                haptic("light");
                onChange(opt.value);
              }
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
 * DaisyUI collapse section.
 * @param {{title: string, defaultOpen?: boolean, children?: any}} props
 */
export function Collapsible({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return html`
    <div class="collapse collapse-arrow bg-base-200 rounded-box">
      <input type="checkbox" checked=${open} onChange=${() => { haptic("light"); setOpen(!open); }} />
      <div class="collapse-title font-medium text-sm">${title}</div>
      <div class="collapse-content">${children}</div>
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

  // Detect non-touch (desktop) device
  const [hasTouch, setHasTouch] = useState(false);
  useEffect(() => {
    setHasTouch('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  const THRESHOLD = 64;

  // Desktop refresh handler
  const handleDesktopRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    haptic("medium");
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  const handleTouchStart = useCallback((e) => {
    if (!containerRef.current) return;
    const scrollContainer = containerRef.current.querySelector('.main-content') || containerRef.current;
    if (scrollContainer.scrollTop <= 0) {
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
      ${!hasTouch && html`
        <button
          class="btn btn-circle btn-ghost btn-sm ${refreshing ? 'spinning' : ''}"
          onClick=${handleDesktopRefresh}
          disabled=${refreshing}
          title="Refresh"
          aria-label="Refresh"
        >
          ${ICONS.refresh}
        </button>
      `}
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
 * DaisyUI search input with icon and clear button.
 * @param {{value: string, onInput: (e: Event) => void, placeholder?: string, onClear?: () => void, disabled?: boolean, inputRef?: any}} props
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
    <div class="form-control w-full">
      <label class="input input-bordered input-sm flex items-center gap-2 ${disabled ? 'input-disabled' : ''}">
        <span class="opacity-50">${ICONS.search}</span>
        <input
          ref=${inputRef}
          type="text"
          class="grow bg-transparent border-none outline-none text-sm"
          placeholder=${placeholder}
          value=${value}
          onInput=${onInput}
          disabled=${disabled}
        />
        ${value && !disabled
          ? html`
              <button
                class="btn btn-ghost btn-xs btn-circle"
                onClick=${() => {
                  if (onClear) onClear();
                }}
              >
                ${ICONS.close}
              </button>
            `
          : null}
      </label>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Toggle
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI toggle switch.
 * @param {{checked: boolean, onChange: (checked: boolean) => void, label?: string, disabled?: boolean}} props
 */
export function Toggle({ checked = false, onChange, label, disabled = false }) {
  const handleClick = () => {
    if (!disabled) {
      haptic("light");
      onChange(!checked);
    }
  };

  return html`
    <div class="form-control">
      <label class="label cursor-pointer gap-3 ${disabled ? 'opacity-50' : ''}">
        ${label ? html`<span class="label-text">${label}</span>` : null}
        <input type="checkbox" class="toggle toggle-primary toggle-sm" checked=${checked} onChange=${handleClick} disabled=${disabled} />
      </label>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Stepper
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI join-based numeric stepper.
 * @param {{value: number, min?: number, max?: number, step?: number, onChange: (v: number) => void, label?: string, disabled?: boolean}} props
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
    if (!disabled) {
      const next = Math.max(min, value - step);
      if (next !== value) {
        haptic("light");
        onChange(next);
      }
    }
  };
  const increment = () => {
    if (!disabled) {
      const next = Math.min(max, value + step);
      if (next !== value) {
        haptic("light");
        onChange(next);
      }
    }
  };

  return html`
    <div class="flex items-center gap-3 ${disabled ? 'opacity-50' : ''}">
      ${label ? html`<span class="text-sm flex-1">${label}</span>` : null}
      <div class="join">
        <button class="join-item btn btn-sm" onClick=${decrement} disabled=${disabled || value <= min}>−</button>
        <span class="join-item btn btn-sm btn-ghost no-animation pointer-events-none tabular-nums">${value}</span>
        <button class="join-item btn btn-sm" onClick=${increment} disabled=${disabled || value >= max}>+</button>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  SliderControl
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI range slider with value badge.
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
    <div class="form-control w-full gap-1">
      ${label
        ? html`<div class="flex items-center justify-between">
            <span class="label-text text-sm">${label}</span>
            <span class="badge badge-sm badge-ghost">${value}${suffix}</span>
          </div>`
        : null}
      <div class="flex items-center gap-3">
        <input
          type="range"
          class="range range-primary range-sm flex-1"
          min=${min}
          max=${max}
          step=${step}
          value=${value}
          onInput=${(e) => onChange(Number(e.target.value))}
        />
        ${!label ? html`<span class="badge badge-sm badge-ghost">${value}${suffix}</span>` : null}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  Dropdown
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI dropdown component.
 * @param {{label: string|any, items: Array<{value: string, label: string, icon?: any}>, onSelect: (value: string) => void, align?: 'start'|'end', className?: string}} props
 */
export function Dropdown({ label, items = [], onSelect, align = "start", className = "" }) {
  return html`
    <div class="dropdown ${align === 'end' ? 'dropdown-end' : ''} ${className}">
      <div tabindex="0" role="button" class="btn btn-sm btn-ghost m-1">${label} ▾</div>
      <ul tabindex="0" class="dropdown-content menu bg-base-200 rounded-box z-50 w-52 p-2 shadow-lg border border-base-content/10">
        ${items.map(item => html`
          <li key=${item.value}>
            <a class="text-sm" onClick=${(e) => { e.preventDefault(); onSelect(item.value); document.activeElement?.blur(); }}>
              ${item.icon || ""}${item.label}
            </a>
          </li>
        `)}
      </ul>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  SelectInput
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI styled select input.
 * @param {{value: string, options: Array<{value: string, label: string}|string>, onChange: (value: string) => void, placeholder?: string, size?: 'xs'|'sm'|'md', className?: string}} props
 */
export function SelectInput({ value, options = [], onChange, placeholder, size = "sm", className = "" }) {
  const normalizedOpts = options.map(o => typeof o === "string" ? { value: o, label: o } : o);
  return html`
    <select
      class="select select-bordered select-${size} w-full ${className}"
      value=${value}
      onChange=${(e) => onChange(e.target.value)}
    >
      ${placeholder ? html`<option disabled selected=${!value}>${placeholder}</option>` : null}
      ${normalizedOpts.map(opt => html`
        <option key=${opt.value} value=${opt.value}>${opt.label}</option>
      `)}
    </select>
  `;
}

/* ═══════════════════════════════════════════════
 *  DataTable
 * ═══════════════════════════════════════════════ */

/**
 * DaisyUI data table with optional search and sort.
 * @param {{columns: Array<{key: string, label: string, sortable?: boolean, render?: (val, row) => any}>, data: Array<Object>, searchable?: boolean, searchKeys?: string[], emptyMessage?: string, onRowClick?: (row: Object) => void, compact?: boolean}} props
 */
export function DataTable({ columns = [], data = [], searchable = false, searchKeys, emptyMessage = "No data", onRowClick, compact = false }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    const keys = searchKeys || columns.map(c => c.key);
    return data.filter(row => keys.some(k => String(row[k] || "").toLowerCase().includes(q)));
  }, [data, search, searchKeys, columns]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  return html`
    <div class="w-full">
      ${searchable ? html`
        <div class="mb-3">
          <input type="text" placeholder="Search…" class="input input-bordered input-sm w-full max-w-xs"
            value=${search} onInput=${(e) => setSearch(e.target.value)} />
        </div>
      ` : null}
      <div class="overflow-x-auto rounded-box border border-base-content/5">
        <table class="table ${compact ? 'table-compact' : ''} table-zebra">
          <thead>
            <tr>
              ${columns.map(col => html`
                <th key=${col.key}
                  class=${col.sortable ? "cursor-pointer select-none hover:bg-base-200" : ""}
                  onClick=${col.sortable ? () => handleSort(col.key) : undefined}>
                  <span class="flex items-center gap-1">
                    ${col.label}
                    ${col.sortable && sortKey === col.key ? html`<span class="text-xs">${sortDir === "asc" ? "▲" : "▼"}</span>` : ""}
                  </span>
                </th>
              `)}
            </tr>
          </thead>
          <tbody>
            ${sorted.length === 0 ? html`
              <tr><td colspan=${columns.length} class="text-center opacity-50 py-8">${emptyMessage}</td></tr>
            ` : sorted.map((row, idx) => html`
              <tr key=${row.id || idx}
                class=${onRowClick ? "hover cursor-pointer" : "hover"}
                onClick=${onRowClick ? () => onRowClick(row) : undefined}>
                ${columns.map(col => html`
                  <td key=${col.key} class="truncate max-w-xs">
                    ${col.render ? col.render(row[col.key], row) : row[col.key] ?? "—"}
                  </td>
                `)}
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
