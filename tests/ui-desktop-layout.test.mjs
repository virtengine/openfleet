import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("desktop layout implementation", () => {
  const source = readFileSync(resolve(process.cwd(), "ui/app.js"), "utf8");
  const layoutCss = readFileSync(resolve(process.cwd(), "ui/styles/layout.css"), "utf8");

  it("uses the 1200px desktop breakpoint and tablet-aware bottom nav gating", () => {
    expect(source).toContain("const DESKTOP_MIN_WIDTH = 1200;");
    expect(source).toContain("const WIDE_DESKTOP_MIN_WIDTH = 1400;");
    expect(source).toContain("app-desktop-grid");
    expect(layoutCss).toContain(".app-desktop-grid");
    expect(source).toContain("const showBottomNav = !(isDesktop || isTablet);");
    expect(source).toContain("const showSessionRail = isWideDesktop && isChat;");
    expect(layoutCss).toContain("@media (min-width: 1400px)");
  });

  it("persists sidebar and inspector layout state", () => {
    expect(source).toContain('localStorage.setItem("ve-sidebar-width", String(sidebarWidth));');
    expect(source).toContain('localStorage.setItem("ve-inspector-collapsed", String(inspectorCollapsed));');
    expect(source).toContain('readBool("ve-inspector-collapsed")');
  });

  it("adds inspector collapse control and tablet/desktop nav CSS", () => {
    expect(source).toContain('class="inspector-collapse-btn"');
    expect(layoutCss).toContain('@media (min-width: 768px) and (max-width: 1199px)');
    expect(layoutCss).toContain('.inspector-collapse-btn');
  });

  it("keeps the tablet shell on a single main column while drawers are hidden", () => {
    expect(layoutCss).toContain('.app-tablet-grid');
    expect(layoutCss).toContain('grid-template-areas: "main";');
    expect(layoutCss).toContain('.app-main {');
  });

  it("supports desktop keyboard shortcuts for sidebar and inspector", () => {
    expect(source).toContain('key === "b"');
    expect(source).toContain('key === "i"');
    expect(source).toContain('setSidebarCollapsed((value) => !value);');
    expect(source).toContain('setInspectorCollapsed((value) => !value);');
  });

  it("renders accessible navigation and panel landmarks", () => {
    expect(source).toContain('aria-label="Breadcrumb"');
    expect(source).toContain('aria-label="Main navigation"');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain('aria-label="Inspector panel"');
    expect(source).toContain('aria-label=${collapsed ? "Expand inspector" : "Collapse inspector"}');
  });

  it("supports sidebar keyboard focus navigation", () => {
    expect(source).toContain('const navRef = useRef(null);');
    expect(source).toContain('const handleSidebarKeyDown = (event) => {');
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('event.key === "Home"');
    expect(source).toContain('event.key === "End"');
    expect(source).toContain('querySelectorAll(\'[role="tab"]\')');
    expect(source).toContain('onKeyDown=${handleSidebarKeyDown}');
  });
});
