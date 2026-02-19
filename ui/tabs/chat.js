/* ─────────────────────────────────────────────────────────────
 *  Tab: Chat — dedicated ChatGPT-style session interface
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useEffect, useState, useCallback } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { Card } from "../components/shared.js";
import {
  SessionList,
  loadSessions,
  selectedSessionId,
  sessionsData,
} from "../components/session-list.js";
import { ChatView } from "../components/chat-view.js";

export function ChatTab() {
  const [showArchived, setShowArchived] = useState(false);
  const sessionId = selectedSessionId.value;

  useEffect(() => {
    let mounted = true;
    loadSessions();
    const interval = setInterval(() => {
      if (mounted) loadSessions();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const sessions = sessionsData.value || [];
    if (selectedSessionId.value || sessions.length === 0) return;
    const next =
      sessions.find((s) => s.status === "active" || s.status === "running") ||
      sessions[0];
    if (next?.id) selectedSessionId.value = next.id;
  }, [sessionsData.value, selectedSessionId.value]);

  const handleBack = useCallback(() => {
    selectedSessionId.value = null;
  }, []);

  return html`
    <${Card} title="Chat Sessions">
      <div class="session-split">
        <${SessionList}
          showArchived=${showArchived}
          onToggleArchived=${setShowArchived}
          defaultType="primary"
        />
        <div class="session-detail">
          ${sessionId && html`
            <button class="session-back-btn" onClick=${handleBack}>
              ← Back to sessions
            </button>
          `}
          ${sessionId
            ? html`<${ChatView} sessionId=${sessionId} />`
            : html`
                <div class="chat-view chat-empty-state">
                  <div class="session-empty-icon">💬</div>
                  <div class="session-empty-text">Select a session</div>
                </div>
              `}
        </div>
      </div>
    <//>
  `;
}
