import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const boardSource = readFileSync(
  resolve(process.cwd(), "ui/components/kanban-board.js"),
  "utf8",
);
const cssSource = readFileSync(
  resolve(process.cwd(), "ui/styles/kanban.css"),
  "utf8",
);

describe("kanban scroll regression guards", () => {
  it("keeps multiple load-more triggers for per-column pagination", () => {
    expect(boardSource).toMatch(/IntersectionObserver/);
    expect(boardSource).toMatch(/useLayoutEffect/);
    expect(boardSource).toMatch(/onScroll=\$\{onCardsScroll\}/);
    expect(boardSource).toMatch(/onWheel=\$\{onCardsWheel\}/);
    expect(boardSource).toMatch(/class="kanban-load-more"/);
  });

  it("keeps the manual load-more affordance outside the scroll body", () => {
    const cardsIndex = boardSource.indexOf('class="kanban-cards"');
    const sentinelIndex = boardSource.indexOf('class="kanban-tail-sentinel"');
    const footerIndex = boardSource.indexOf('class="kanban-column-footer"');
    expect(cardsIndex).toBeGreaterThan(-1);
    expect(sentinelIndex).toBeGreaterThan(cardsIndex);
    expect(footerIndex).toBeGreaterThan(sentinelIndex);
  });

  it("keeps columns as bounded independent scroll lanes", () => {
    expect(cssSource).toMatch(/\.kanban-column \{[\s\S]*overflow: hidden;/);
    expect(cssSource).toMatch(/\.kanban-cards \{[\s\S]*overflow-y: auto;/);
    expect(cssSource).toMatch(/\.kanban-cards \{[\s\S]*touch-action: pan-y;/);
    expect(cssSource).toMatch(/\.kanban-column-footer \{[\s\S]*position: sticky;/);
    expect(cssSource).toMatch(/\.kanban-column \{[\s\S]*height: clamp\(/);
  });
});
