import { describe, expect, it } from "vitest";
import { shouldBlockTabSwipe } from "../ui/modules/router.js";

function targetWithClosest(matches = []) {
  return {
    closest(selector) {
      return matches.includes(selector) ? { selector } : null;
    },
  };
}

describe("tab swipe guard", () => {
  it("always blocks tab swipe while workflows tab is active", () => {
    expect(shouldBlockTabSwipe(null, "workflows")).toBe(true);
  });

  it("blocks tab swipe on workflow canvas interaction targets", () => {
    expect(
      shouldBlockTabSwipe(targetWithClosest([".wf-canvas-container"]), "dashboard"),
    ).toBe(true);
  });

  it("keeps existing swipe blocks for kanban and chat zones", () => {
    expect(
      shouldBlockTabSwipe(targetWithClosest([".kanban-board"]), "tasks"),
    ).toBe(true);
    expect(
      shouldBlockTabSwipe(targetWithClosest([".chat-messages"]), "chat"),
    ).toBe(true);
  });

  it("allows swipes for generic content outside blocked zones", () => {
    expect(shouldBlockTabSwipe(targetWithClosest([".something-else"]), "dashboard")).toBe(
      false,
    );
  });
});
