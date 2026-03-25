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
    expect(source).toContain("buildSessionApiPath(id, \"\", { workspace: \"all\" })");
    expect(source).toContain("shouldFallbackToAllSessions");
    expect(source).toContain("getSessionListState");
    expect(source).toContain("sessionsError.value = hasCachedData ? null : nextErrorState;");
    expect(source).toContain("const shouldRetainScopedSelection =");
    expect(source).toContain('workspaceScope !== "all"');
    expect(source).toContain("selectedSessionId.value = selectedSessionStillExists ? currentSelectedSessionId : null;");

    const loadMessagesPattern = /export async function loadSessionMessages[\s\S]*?\n}\n\nfunction normalizePreview/;
    const loadMessagesBlock = loadMessagesPattern.exec(source)?.[0] || "";
    expect(loadMessagesBlock).not.toContain("sessionMessages.value = [];");
    expect(loadMessagesBlock).not.toContain("sessionPagination.value = null;");
    expect(loadMessagesBlock).toContain("const shouldRetryAll = shouldFallbackToAllSessions(err, baseUrl, fallbackUrl);");
    expect(loadMessagesBlock).toContain("res = await fetchSessionAtPath(fallbackUrl, limit, opts.offset);");
  });

  it("keeps retained selection during list failures and recovers deterministically", () => {
    const source = read("ui/components/session-list.js");
    expect(source).toContain('const currentSelectedSessionId = String(selectedSessionId.value || "").trim();');
    expect(source).toContain('const workspaceScope = String(normalizedFilter.workspace || "active").trim().toLowerCase();');
    expect(source).toContain("const shouldRetainScopedSelection =");
    expect(source).toContain("const selectedSessionStillExists =");
    expect(source).toContain("sessionsError.value = hasCachedData ? null : nextErrorState;");
    expect(source).toContain("const listState = getSessionListState({");
  });

  it("retries inspector full-session fetches against workspace=all when scoped lookups 404", () => {
    const source = read("ui/app.js");
    expect(source).toContain("const fallbackSessionPath = buildSessionApiPath(sessionId, \"\", {");
    expect(source).toContain('workspace: "all"');
    expect(source).toContain("const shouldRetryAll = shouldFallbackToAllSessions(");
    expect(source).toContain("res = await apiFetch(fallbackSessionPath, { _silent: true });");
  });

  it("exposes workspace metadata in session summaries for UI routing", () => {
    const source = read("infra/session-tracker.mjs");
    expect(source).toContain("workspaceId: String(s?.metadata?.workspaceId || \"\").trim() || null");
    expect(source).toContain("workspaceDir: String(s?.metadata?.workspaceDir || \"\").trim() || null");
  });
});

