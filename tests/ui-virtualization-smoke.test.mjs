/* ─────────────────────────────────────────────────────────────────────
 *  Smoke tests — UI virtualised table helpers (Logs + Tasks)
 *
 *  These tests verify the windowing maths that drive spacer-row
 *  rendering in the Logs and Tasks tabs.  They run in node/vitest
 *  without a real DOM; they exercise the pure functions / constants
 *  that feed the virtualised render paths.
 * ───────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from "vitest";

/* ── Shared constants (mirror the values used in the components) ── */
const LOG_FILE_ROW_HEIGHT = 44;
const LOG_FILE_SCROLL_BUFFER = 12;
const HISTORY_ROW_HEIGHT = 46;
const HISTORY_SCROLL_BUFFER = 16;
const SYSLOG_LINE_HEIGHT = 20;
const SYSLOG_SCROLL_BUFFER = 30;

/**
 * Compute the virtualisation window for a scrollable table.
 *
 * @param {{ scrollTop: number, containerHeight: number, rowHeight: number, buffer: number, totalRows: number }}
 * @returns {{ startIdx: number, endIdx: number, topSpacer: number, bottomSpacer: number, visibleCount: number }}
 */
function computeWindow({ scrollTop, containerHeight, rowHeight, buffer, totalRows }) {
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const startIdx = Math.max(0, firstVisible - buffer);
  const visibleCount = Math.ceil(containerHeight / rowHeight);
  const endIdx = Math.min(totalRows, firstVisible + visibleCount + buffer);
  const topSpacer = startIdx * rowHeight;
  const bottomSpacer = Math.max(0, (totalRows - endIdx) * rowHeight);
  return { startIdx, endIdx, topSpacer, bottomSpacer, visibleCount };
}

/* ────────────────────────────────────────────────────────────────── */
describe("Log Files table virtualisation", () => {
  it("renders a small dataset without spacers", () => {
    const w = computeWindow({
      scrollTop: 0,
      containerHeight: 320,
      rowHeight: LOG_FILE_ROW_HEIGHT,
      buffer: LOG_FILE_SCROLL_BUFFER,
      totalRows: 5,
    });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(5);
    expect(w.topSpacer).toBe(0);
    expect(w.bottomSpacer).toBe(0);
  });

  it("windows a large dataset at the top", () => {
    const w = computeWindow({
      scrollTop: 0,
      containerHeight: 320,
      rowHeight: LOG_FILE_ROW_HEIGHT,
      buffer: LOG_FILE_SCROLL_BUFFER,
      totalRows: 500,
    });
    expect(w.startIdx).toBe(0);
    expect(w.topSpacer).toBe(0);
    expect(w.endIdx).toBeGreaterThan(0);
    expect(w.endIdx).toBeLessThan(500);
    expect(w.bottomSpacer).toBeGreaterThan(0);
  });

  it("windows a large dataset scrolled to the middle", () => {
    const scrollTop = 200 * LOG_FILE_ROW_HEIGHT; // scrolled to row ~200
    const w = computeWindow({
      scrollTop,
      containerHeight: 320,
      rowHeight: LOG_FILE_ROW_HEIGHT,
      buffer: LOG_FILE_SCROLL_BUFFER,
      totalRows: 500,
    });
    expect(w.startIdx).toBeGreaterThan(0);
    expect(w.topSpacer).toBeGreaterThan(0);
    expect(w.endIdx).toBeLessThan(500);
    expect(w.bottomSpacer).toBeGreaterThan(0);
    // visible window should be reasonable
    const rendered = w.endIdx - w.startIdx;
    expect(rendered).toBeGreaterThan(w.visibleCount);
    expect(rendered).toBeLessThan(w.visibleCount + 2 * LOG_FILE_SCROLL_BUFFER + 2);
  });

  it("windows a large dataset scrolled to the bottom", () => {
    const totalRows = 500;
    const scrollTop = (totalRows - 8) * LOG_FILE_ROW_HEIGHT;
    const w = computeWindow({
      scrollTop,
      containerHeight: 320,
      rowHeight: LOG_FILE_ROW_HEIGHT,
      buffer: LOG_FILE_SCROLL_BUFFER,
      totalRows,
    });
    expect(w.endIdx).toBe(totalRows);
    expect(w.bottomSpacer).toBe(0);
    expect(w.topSpacer).toBeGreaterThan(0);
  });

  it("handles zero rows gracefully", () => {
    const w = computeWindow({
      scrollTop: 0,
      containerHeight: 320,
      rowHeight: LOG_FILE_ROW_HEIGHT,
      buffer: LOG_FILE_SCROLL_BUFFER,
      totalRows: 0,
    });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(0);
    expect(w.topSpacer).toBe(0);
    expect(w.bottomSpacer).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────── */
describe("Task History table virtualisation", () => {
  it("renders a small history without spacers", () => {
    const w = computeWindow({
      scrollTop: 0,
      containerHeight: 360,
      rowHeight: HISTORY_ROW_HEIGHT,
      buffer: HISTORY_SCROLL_BUFFER,
      totalRows: 10,
    });
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(10);
    expect(w.topSpacer).toBe(0);
    expect(w.bottomSpacer).toBe(0);
  });

  it("windows a large history scrolled partway", () => {
    const scrollTop = 50 * HISTORY_ROW_HEIGHT;
    const w = computeWindow({
      scrollTop,
      containerHeight: 360,
      rowHeight: HISTORY_ROW_HEIGHT,
      buffer: HISTORY_SCROLL_BUFFER,
      totalRows: 300,
    });
    expect(w.startIdx).toBeGreaterThan(0);
    expect(w.topSpacer).toBeGreaterThan(0);
    expect(w.endIdx).toBeLessThan(300);
    expect(w.bottomSpacer).toBeGreaterThan(0);
  });

  it("snaps endIdx to total when near bottom", () => {
    const totalRows = 300;
    const scrollTop = (totalRows - 2) * HISTORY_ROW_HEIGHT;
    const w = computeWindow({
      scrollTop,
      containerHeight: 360,
      rowHeight: HISTORY_ROW_HEIGHT,
      buffer: HISTORY_SCROLL_BUFFER,
      totalRows,
    });
    expect(w.endIdx).toBe(totalRows);
    expect(w.bottomSpacer).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────── */
describe("System Logs virtualisation", () => {
  it("windows system log lines at the top", () => {
    const w = computeWindow({
      scrollTop: 0,
      containerHeight: 400,
      rowHeight: SYSLOG_LINE_HEIGHT,
      buffer: SYSLOG_SCROLL_BUFFER,
      totalRows: 2000,
    });
    expect(w.startIdx).toBe(0);
    expect(w.topSpacer).toBe(0);
    expect(w.endIdx).toBeLessThan(2000);
    expect(w.bottomSpacer).toBeGreaterThan(0);
  });

  it("windows system log lines in the middle", () => {
    const scrollTop = 1000 * SYSLOG_LINE_HEIGHT;
    const w = computeWindow({
      scrollTop,
      containerHeight: 400,
      rowHeight: SYSLOG_LINE_HEIGHT,
      buffer: SYSLOG_SCROLL_BUFFER,
      totalRows: 2000,
    });
    expect(w.startIdx).toBeGreaterThan(0);
    expect(w.endIdx).toBeLessThan(2000);
    const rendered = w.endIdx - w.startIdx;
    expect(rendered).toBeLessThan(120); // buffer is 30 each side + ~20 visible
  });
});

/* ────────────────────────────────────────────────────────────────── */
describe("cursor-based pagination contract", () => {
  it("encodes a cursor from mtimeMs and base64url name", () => {
    const mtimeMs = 1710000000000;
    const name = "agent-20260315-1709.log";
    const cursor = `${mtimeMs}:${Buffer.from(name).toString("base64url")}`;
    expect(cursor).toContain("1710000000000:");
    // Decode and verify roundtrip
    const [ts, encoded] = cursor.split(":");
    expect(Number(ts)).toBe(mtimeMs);
    expect(Buffer.from(encoded, "base64url").toString()).toBe(name);
  });
});
