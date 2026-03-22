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
    expect(source).toContain("normalizeSessionWorkspaceHint");
    expect(source).toContain("omits malformed workspace hints");
    expect(source).toContain("sessionPath(id, action = \"\")");
    expect(source).toContain("buildSessionApiPath(id, \"\", { workspace: \"all\" })");
    expect(source).toContain("isScopedSessionNotFound");

    const loadMessagesBlock =
      source.match(/export async function loadSessionMessages[\s\S]*?\n}\n\nfunction normalizePreview/)?.[0] || "";
    expect(loadMessagesBlock).not.toContain("sessionMessages.value = [];");
    expect(loadMessagesBlock).not.toContain("sessionPagination.value = null;");
  });

  it("retries inspector full-session fetches against workspace=all when scoped lookups 404", () => {
    const source = read("ui/app.js");
    expect(source).toContain("const fallbackSessionPath = buildSessionApiPath(sessionId, \"\", {");
    expect(source).toContain('workspace: "all"');
    expect(source).toContain("errorText.includes(\"session not found\") || errorText.includes(\"request failed (404)\")");
    expect(source).toContain("res = await apiFetch(fallbackSessionPath, { _silent: true });");
  });

  it("exposes workspace metadata in session summaries for UI routing", () => {
    const source = read("infra/session-tracker.mjs");
    expect(source).toContain("workspaceId: String(s?.metadata?.workspaceId || \"\").trim() || null");
    expect(source).toContain("workspaceDir: String(s?.metadata?.workspaceDir || \"\").trim() || null");
  });
});


