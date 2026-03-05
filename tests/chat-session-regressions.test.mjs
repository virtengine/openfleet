import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relPath) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

describe("chat session regressions", () => {
  it("keeps per-session pending attachment drafts and drag overlay in chat tab", () => {
    const source = read("ui/tabs/chat.js");
    expect(source).toContain("pendingAttachmentsBySessionId");
    expect(source).toContain("DRAFT_SESSION_KEY");
    expect(source).toContain("Drop files to attach");
    expect(source).toContain("Files can be dropped anywhere in this chat.");
    expect(source).toContain("onDragEnter=${handleChatDragEnter}");
    expect(source).toContain("sessionApiPath(targetSessionId, \"attachments\")");
  });

  it("routes session list/detail calls through workspace-aware session API paths", () => {
    const source = read("ui/components/session-list.js");
    expect(source).toContain("buildSessionApiPath");
    expect(source).toContain("resolveSessionWorkspaceHint");
    expect(source).toContain("sessionPath(id, action = \"\")");
  });

  it("exposes workspace metadata in session summaries for UI routing", () => {
    const source = read("infra/session-tracker.mjs");
    expect(source).toContain("workspaceId: String(s?.metadata?.workspaceId || \"\").trim() || null");
    expect(source).toContain("workspaceDir: String(s?.metadata?.workspaceDir || \"\").trim() || null");
  });
});
