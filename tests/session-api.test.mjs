import { describe, expect, it } from "vitest";

import { buildSessionApiPath, resolveSessionWorkspaceHint } from "../ui/modules/session-api.js";

describe("session api workspace routing", () => {
  it("preserves workspace=all in session detail paths", () => {
    const path = buildSessionApiPath("abc123", "", { workspace: "all" });
    expect(path).toBe("/api/sessions/abc123?workspace=all");
  });

  it("normalizes wildcard workspace hints to all", () => {
    const path = buildSessionApiPath("abc123", "message", { workspace: "*" });
    expect(path).toBe("/api/sessions/abc123/message?workspace=all");
  });

  it("falls back to all when session metadata is absent", () => {
    expect(resolveSessionWorkspaceHint(null, "all")).toBe("all");
  });
});