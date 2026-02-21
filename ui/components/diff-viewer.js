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
    <div class="card bg-base-200 shadow-sm mb-2">
      <div
        class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-base-300 rounded-t-lg transition-colors ${statusClass === 'added' ? 'border-l-2 border-success' : statusClass === 'deleted' ? 'border-l-2 border-error' : ''}"
        onClick=${() => setExpanded(!expanded)}
      >
        <span class="text-base flex-shrink-0">${fileIcon(file.filename)}</span>
        <span class="text-sm font-medium truncate flex-1">${file.filename}</span>
        <span class="flex items-center gap-2 text-xs flex-shrink-0">
          ${additions > 0 && html`<span class="text-success font-mono">+${additions}</span>`}
          ${deletions > 0 && html`<span class="text-error font-mono">-${deletions}</span>`}
        </span>
        <span class="text-xs opacity-60">${expanded ? "▾" : "▸"}</span>
      </div>
      ${expanded && lines.length > 0 && html`
        <div class="bg-base-300 rounded-b-lg p-3 font-mono text-xs overflow-x-auto">
          ${lines.map(
            (line) => html`
              <div key=${line.index} class="${line.type === 'addition' ? 'bg-success/10 text-success' : line.type === 'deletion' ? 'bg-error/10 text-error' : line.type === 'hunk-header' ? 'bg-info/10 text-info opacity-70' : ''} px-2 py-0.5 whitespace-pre">
                <span>${line.text}</span>
              </div>
            `,
          )}
        </div>
      `}
      ${expanded && lines.length === 0 && html`
        <div class="bg-base-300 rounded-b-lg p-3 font-mono text-xs">
          <div class="opacity-50 px-2 py-0.5">
            <span>(no diff available)</span>
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
      <div class="flex flex-col items-center justify-center gap-2 py-12 opacity-60">
        <div class="text-3xl">📝</div>
        <div class="text-sm">Select a session to view diffs</div>
      </div>
    `;
  }

  if (loading) {
    return html`
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-center py-8 text-sm opacity-60">Loading diff…</div>
      </div>
    `;
  }

  if (error) {
    return html`
      <div class="flex flex-col gap-3">
        <div class="flex flex-col items-center justify-center gap-2 py-12 opacity-60">
          <div class="text-3xl">📝</div>
          <div class="text-sm">Diff not available</div>
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
    <div class="flex flex-col gap-3">
      ${files.length > 0 && html`
        <div class="flex items-center gap-3 text-sm px-1">
          <span class="font-medium">${files.length} file${files.length !== 1 ? "s" : ""} changed</span>
          ${totalAdditions > 0 && html`<span class="text-success font-mono">+${totalAdditions}</span>`}
          ${totalDeletions > 0 && html`<span class="text-error font-mono">-${totalDeletions}</span>`}
        </div>
      `}
      <div class="flex flex-col gap-2">
        ${files.length > 0
          ? files.map(
              (f) => html`<${DiffFile} key=${f.filename} file=${f} />`,
            )
          : html`
              <div class="flex flex-col items-center justify-center gap-2 py-12 opacity-60">
                <div class="text-3xl">✨</div>
                <div class="text-sm">No changes yet</div>
              </div>
            `}
      </div>
    </div>
  `;
}
