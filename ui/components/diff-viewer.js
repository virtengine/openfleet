/* ─────────────────────────────────────────────────────────────
 *  Component: Diff Viewer — VS Code-style diff display
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../modules/api.js";

const html = htm.bind(h);

/* ─── File type icons ─── */
const EXT_ICONS = {
  js: "📜", mjs: "📜", cjs: "📜",
  ts: "🔷", tsx: "🔷",
  json: "📋", yaml: "📋", yml: "📋", toml: "📋",
  css: "🎨", scss: "🎨", less: "🎨",
  html: "🌐", htm: "🌐",
  md: "📝", txt: "📄",
  py: "🐍", rb: "💎", go: "🔵", rs: "🦀",
  sh: "🐚", bash: "🐚", ps1: "🐚",
  sql: "🗃️", graphql: "🗃️",
};

function fileIcon(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  return EXT_ICONS[ext] || "📄";
}

/* ─── Parse unified diff into lines ─── */
function parseDiffLines(rawDiff) {
  if (!rawDiff) return [];
  return rawDiff.split("\n").map((line, i) => {
    let type = "context";
    if (line.startsWith("+") && !line.startsWith("+++")) type = "addition";
    else if (line.startsWith("-") && !line.startsWith("---")) type = "deletion";
    else if (line.startsWith("@@")) type = "hunk-header";
    return { text: line, type, index: i };
  });
}

/* ─── DiffFile component ─── */
function DiffFile({ file }) {
  const [expanded, setExpanded] = useState(false);
  const lines = parseDiffLines(file.patch || file.diff);
  const additions = file.additions ?? lines.filter((l) => l.type === "addition").length;
  const deletions = file.deletions ?? lines.filter((l) => l.type === "deletion").length;

  const statusClass = file.status === "added"
    ? "added"
    : file.status === "removed" || file.status === "deleted"
      ? "deleted"
      : "modified";

  return html`
    <div class="diff-file-item">
      <div
        class="diff-file-header ${statusClass}"
        onClick=${() => setExpanded(!expanded)}
      >
        <span class="diff-file-icon">${fileIcon(file.filename)}</span>
        <span class="diff-file-name">${file.filename}</span>
        <span class="diff-file-stats">
          ${additions > 0 && html`<span class="diff-stat-add">+${additions}</span>`}
          ${deletions > 0 && html`<span class="diff-stat-del">-${deletions}</span>`}
        </span>
        <span class="diff-file-toggle">${expanded ? "▾" : "▸"}</span>
      </div>
      ${expanded && lines.length > 0 && html`
        <div class="diff-hunk">
          ${lines.map(
            (line) => html`
              <div key=${line.index} class="diff-line ${line.type}">
                <span class="diff-line-text">${line.text}</span>
              </div>
            `,
          )}
        </div>
      `}
      ${expanded && lines.length === 0 && html`
        <div class="diff-hunk">
          <div class="diff-line context">
            <span class="diff-line-text">(no diff available)</span>
          </div>
        </div>
      `}
    </div>
  `;
}

/* ─── DiffViewer component ─── */
export function DiffViewer({ sessionId }) {
  const [diffData, setDiffData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    setLoading(true);
    setError(null);

    apiFetch(`/api/sessions/${sessionId}/diff`, { _silent: true })
      .then((res) => {
        if (!active) return;
        setDiffData(res?.diff || null);
      })
      .catch(() => {
        if (active) setError("unavailable");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [sessionId]);

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    apiFetch(`/api/sessions/${sessionId}/diff`, { _silent: true })
      .then((res) => setDiffData(res?.diff || null))
      .catch(() => setError("unavailable"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (!sessionId) {
    return html`
      <div class="diff-viewer diff-empty">
        <div class="session-empty-icon">📝</div>
        <div class="session-empty-text">Select a session to view diffs</div>
      </div>
    `;
  }

  if (loading) {
    return html`
      <div class="diff-viewer">
        <div class="diff-loading">Loading diff…</div>
      </div>
    `;
  }

  if (error) {
    return html`
      <div class="diff-viewer">
        <div class="session-empty">
          <div class="session-empty-icon">📝</div>
          <div class="session-empty-text">Diff not available</div>
          <button class="btn btn-primary btn-sm" onClick=${handleRetry}>
            Retry
          </button>
        </div>
      </div>
    `;
  }

  const files = diffData?.files || [];
  const totalAdditions = files.reduce(
    (n, f) => n + (f.additions ?? 0),
    0,
  );
  const totalDeletions = files.reduce(
    (n, f) => n + (f.deletions ?? 0),
    0,
  );

  return html`
    <div class="diff-viewer">
      ${files.length > 0 && html`
        <div class="diff-summary">
          <span>${files.length} file${files.length !== 1 ? "s" : ""} changed</span>
          ${totalAdditions > 0 && html`<span class="diff-stat-add">+${totalAdditions}</span>`}
          ${totalDeletions > 0 && html`<span class="diff-stat-del">-${totalDeletions}</span>`}
        </div>
      `}
      <div class="diff-file-list">
        ${files.length > 0
          ? files.map(
              (f) => html`<${DiffFile} key=${f.filename} file=${f} />`,
            )
          : html`
              <div class="session-empty">
                <div class="session-empty-icon">✨</div>
                <div class="session-empty-text">No changes yet</div>
              </div>
            `}
      </div>
    </div>
  `;
}
