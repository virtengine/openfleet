import React from "react";
import htm from "htm";
import { Box, Text, useInput, useStdout } from "ink";

import {
  buildOsc52CopySequence,
  formatRetryQueueCountdown,
  projectSessionRow,
  reconcileSessionEntries,
} from "./agents-screen-helpers.mjs";

const html = htm.bind(React.createElement);
const FIXED_TABLE_WIDTH = 2 + 8 + 12 + 8 + 10 + 12 + 14 + 7;

function pad(text, width, align = "left") {
  const value = String(text || "");
  if (width <= 0) return "";
  if (value.length >= width) return value.slice(0, width);
  if (align === "right") return `${" ".repeat(width - value.length)}${value}`;
  return `${value}${" ".repeat(width - value.length)}`;
}

function renderCell(value, width, { color, inverse, dimColor, align = "left" } = {}) {
  return html`
    <${Box} width=${width}>
      <${Text} color=${color} inverse=${inverse} dimColor=${dimColor}>
        ${pad(value, width, align)}
      <//>
    <//>
  `;
}

function describeSelection(session) {
  return String(session?.id || "").slice(0, 8) || "session";
}

function sessionActionPath(sessionId, action) {
  return `/api/sessions/${encodeURIComponent(String(sessionId || "").trim())}/${action}?workspace=all`;
}

async function fetchJson(host, port, path, init) {
  const response = await fetch(`http://${host}:${port}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function summarizeDiff(diffPayload) {
  const diff = diffPayload?.diff || {};
  const files = Array.isArray(diff.files) ? diff.files : [];
  return {
    summary: String(diffPayload?.summary || diff.formatted || "").trim() || "(no diff summary)",
    files: files.slice(0, 12).map((file) => ({
      name: file.filename || file.path || "unknown",
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
    })),
  };
}

function sessionMessagesToLogLines(sessionPayload) {
  const messages = Array.isArray(sessionPayload?.session?.messages)
    ? sessionPayload.session.messages
    : [];
  return messages.slice(-40).map((message) => {
    const ts = String(message.timestamp || "").replace("T", " ").replace("Z", "");
    const role = String(message.role || message.type || "event").padEnd(10, " ");
    const content = String(message.content || "").replace(/\s+/g, " ").trim();
    return `${ts}  ${role}  ${content}`;
  });
}

function detailLines(sessionPayload) {
  const session = sessionPayload?.session || {};
  return [
    `ID        ${session.id || "-"}`,
    `Status    ${session.status || "-"}`,
    `Type      ${session.type || "-"}`,
    `Workspace ${session.metadata?.workspaceId || session.workspaceId || "-"}`,
    `Path      ${session.metadata?.workspaceDir || session.workspaceDir || "-"}`,
    `Model     ${session.metadata?.model || session.model || "-"}`,
    `Agent     ${session.metadata?.agent || session.agent || "-"}`,
    `Turns     ${session.turnCount || 0}`,
    `Messages  ${Array.isArray(session.messages) ? session.messages.length : 0}`,
  ];
}

export default function AgentsScreen({ wsBridge, host = "127.0.0.1", port = 3080 }) {
  const resolvedHost = wsBridge?.host || host;
  const resolvedPort = wsBridge?.port || port;
  const { stdout } = useStdout();
  const liveSessionsRef = React.useRef([]);
  const [entries, setEntries] = React.useState([]);
  const [retryQueue, setRetryQueue] = React.useState({ count: 0, items: [] });
  const [selectedId, setSelectedId] = React.useState("");
  const [showBackoff, setShowBackoff] = React.useState(true);
  const [detailView, setDetailView] = React.useState(null);
  const [logLines, setLogLines] = React.useState([]);
  const [diffView, setDiffView] = React.useState(null);
  const [confirmKill, setConfirmKill] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState("");
  const [clockMs, setClockMs] = React.useState(Date.now());

  const applyRetryQueue = React.useCallback((payload) => {
    setRetryQueue({
      count: Number(payload?.count || 0),
      items: Array.isArray(payload?.items) ? payload.items : [],
    });
  }, []);

  const applySessionSnapshot = React.useCallback((incomingSessions, now = Date.now()) => {
    liveSessionsRef.current = Array.isArray(incomingSessions) ? incomingSessions : [];
    setClockMs(now);
    setEntries((previous) => {
      const nextEntries = reconcileSessionEntries(previous, liveSessionsRef.current, now);
      setSelectedId((current) => {
        if (current && nextEntries.some((entry) => entry.id === current)) return current;
        return nextEntries[0]?.id || "";
      });
      return nextEntries;
    });
  }, []);

  const refreshData = React.useCallback(async () => {
    try {
      const [sessionsPayload, retryPayload] = await Promise.all([
        fetchJson(resolvedHost, resolvedPort, "/api/sessions?workspace=all"),
        fetchJson(resolvedHost, resolvedPort, "/api/retry-queue"),
      ]);
      const now = Date.now();
      applyRetryQueue(retryPayload);
      applySessionSnapshot(sessionsPayload.sessions || [], now);
    } catch (error) {
      setStatusLine(error.message || String(error));
    }
  }, [applyRetryQueue, applySessionSnapshot, resolvedHost, resolvedPort]);

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      if (!active) return;
      await refreshData();
    };
    void load();
    const intervalId = setInterval(() => {
      const now = Date.now();
      setClockMs(now);
      setEntries((previous) => reconcileSessionEntries(previous, liveSessionsRef.current, now));
    }, 1000);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [refreshData]);

  React.useEffect(() => {
    if (!wsBridge || typeof wsBridge.on !== "function") return undefined;
    const handlers = [
      wsBridge.on("sessions:update", (payload) => {
        const sessions = Array.isArray(payload?.sessions)
          ? payload.sessions
          : Array.isArray(payload)
            ? payload
            : [];
        applySessionSnapshot(sessions, Date.now());
      }),

    );
    setDiffView(summarizeDiff(payload));
    setDetailView(null);
    setLogLines([]);
    setStatusLine("");
  }, [resolvedHost, resolvedPort, selectedSession]);

  const postAction = React.useCallback(
    async (action) => {
      if (!selectedSession?.id) return;
      await fetchJson(resolvedHost, resolvedPort, sessionActionPath(selectedSession.id, action), {
        method: "POST",
      });
      setStatusLine(`${action} sent for ${describeSelection(selectedSession)}`);
      await refreshData();
    },
    [refreshData, resolvedHost, resolvedPort, selectedSession],
  );

  useInput((input, key) => {
    if (confirmKill) {
      if (input === "y" || input === "Y") {
        setConfirmKill(false);
        void postAction("stop");
      } else if (input === "n" || input === "N" || key.escape) {
        setConfirmKill(false);
        setStatusLine("Kill cancelled");
      }
      return;
    }

    if (key.upArrow) {
      const nextIndex = Math.max(0, selectedIndex - 1);
      setSelectedId(entries[nextIndex]?.id || "");
      return;
    }
    if (key.downArrow) {
      const nextIndex = Math.min(entries.length - 1, selectedIndex + 1);
      setSelectedId(entries[nextIndex]?.id || "");
      return;
    }
    if (key.return) {
      void openDetail();
      return;
    }
    if (input === "k" || input === "K") {
      if (selectedSession?.id) setConfirmKill(true);
      return;
    }
    if (input === "p" || input === "P") {
      void postAction("pause");
      return;
    }
    if (input === "r" || input === "R") {
      void postAction("resume");
      return;
    }
    if (input === "l" || input === "L") {
      void openLogs();
      return;
    }
    if (input === "d" || input === "D") {
      void openDiff();
      return;
    }
    if (input === "c" || input === "C") {
      if (selectedSession?.id) {
        stdout.write(buildOsc52CopySequence(selectedSession.id));
        setStatusLine(`Copied ${selectedSession.id}`);
      }
      return;
    }
    if (input === "b" || input === "B") {
      setShowBackoff((current) => !current);
      return;
    }
    if (key.escape) {
      setDetailView(null);
      setLogLines([]);
      setDiffView(null);
      setConfirmKill(false);
    }
  });

  const eventWidth = Math.max(12, (stdout?.columns || 120) - FIXED_TABLE_WIDTH);
  const backoffMessageWidth = Math.max(20, (stdout?.columns || 120) - 34);

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box} borderStyle="single" paddingX=${1}>
        ${renderCell("", 2, {})}
        ${renderCell("ID", 8, { dimColor: true })}
        ${renderCell("STAGE", 12, { dimColor: true })}
        ${renderCell("PID", 8, { dimColor: true })}
        ${renderCell("AGE/TURN", 10, { dimColor: true })}
        ${renderCell("TOKENS", 12, { dimColor: true })}
        ${renderCell("SESSION", 14, { dimColor: true })}
        ${renderCell("EVENT", eventWidth, { dimColor: true })}
      <//>
      ${(entries.length ? entries : [{ id: "empty", session: null }]).map((entry) => {
        if (!entry.session) {
          return html`
            <${Box} key="empty" paddingX=${1}>
              <${Text} dimColor>No sessions<//>
            <//>
          `;
        }
        const row = projectSessionRow(entry.session, clockMs, eventWidth);
        const selected = entry.id === selectedSession?.id;
        return html`
          <${Box} key=${entry.id} paddingX=${1}>
            ${renderCell(row.statusDot, 2, {
              color: row.statusColor,
              inverse: selected,
              dimColor: row.isDimmed || entry.isRetained,
            })}
            ${renderCell(row.idText, 8, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.stageText, 12, {
              inverse: selected,
              color: row.statusColor,
              dimColor: row.isDimmed || entry.isRetained,
            })}
            ${renderCell(row.pidText, 8, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.ageTurnText, 10, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.tokensText, 12, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.sessionText, 14, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
            ${renderCell(row.eventText, eventWidth, { inverse: selected, dimColor: row.isDimmed || entry.isRetained })}
          <//>
        `;
      })}

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>
          Backoff queue (${retryQueue.count || 0}) ${showBackoff ? "[B to collapse]" : "[B to expand]"}
        <//>
        ${showBackoff
          ? (retryQueue.items || []).slice(0, 6).map((item, index) => html`
              <${Text} key=${item.taskId || item.id || index} wrap="truncate-end">
                ${pad(String(item.taskTitle || item.taskId || item.id || `item-${index}`), 16)}
                ${pad(formatRetryQueueCountdown(item, clockMs), 16)}
                ${pad(String(item.lastError || item.error || item.reason || "-"), backoffMessageWidth)}
              <//>
            `)
          : null}
        ${showBackoff && !(retryQueue.items || []).length
          ? html`<${Text} dimColor>No tasks cooling down<//>`
          : null}
      <//>

      ${confirmKill && selectedSession
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="red">Kill ${describeSelection(selectedSession)}? [y/N]<//>
            <//>
          `
        : null}

      ${detailView
        ? html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>Detail<//>
              ${detailView.map((line) => html`<${Text} key=${line}>${line}<//>`)}
            <//>
          `
        : null}

      ${logLines.length
        ? html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>Logs<//>
              ${logLines.map((line, index) => html`
                <${Text} key=${index} wrap="truncate-end">${line}<//>
              `)}
            <//>
          `
        : null}

      ${diffView
        ? html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>Diff<//>
              <${Text}>${diffView.summary}<//>
              ${diffView.files.length
                ? diffView.files.map((file) => html`
                    <${Text} key=${file.name}>
                      ${file.name}  +${file.additions}  -${file.deletions}
                    <//>
                  `)
                : html`<${Text} dimColor>No changed files<//>`}
            <//>
          `
        : null}

      <${Box} marginTop=${1} borderStyle="single" paddingX=${1}>
        <${Text} dimColor>
          [K]ill session  [P]ause  [R]esume  [L]ogs  [D]iff  [C]opy ID  [Enter] Detail
        <//>
      <//>
      ${statusLine
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="yellow">${statusLine}<//>
            <//>
          `
        : null}
    <//>
  `;
}
