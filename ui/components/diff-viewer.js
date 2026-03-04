/* ─────────────────────────────────────────────────────────────
 *  Component: Diff Viewer — VS Code-style diff display (MUI)
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { resolveIcon } from "../modules/icon-utils.js";
import { buildSessionApiPath } from "../modules/session-api.js";
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  Chip,
  Box,
  Stack,
  Button,
  Skeleton,
  Paper,
} from "@mui/material";

const html = htm.bind(h);

function buildDiffApiPath(sessionId, workspace = "active") {
  return buildSessionApiPath(sessionId, "diff", { workspace }) || "";
}

/* ─── File type icons ─── */
const EXT_ICONS = {
  js: "terminal", mjs: "terminal", cjs: "terminal",
  ts: "terminal", tsx: "terminal",
  json: "file", yaml: "file", yml: "file", toml: "file",
  css: "palette", scss: "palette", less: "palette",
  html: "globe", htm: "globe",
  md: "edit", txt: "file",
  py: "terminal", rb: "terminal", go: "terminal", rs: "terminal",
  sh: "terminal", bash: "terminal", ps1: "terminal",
  sql: "archive", graphql: "archive",
};

function fileIcon(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  return resolveIcon(EXT_ICONS[ext] || "file") || EXT_ICONS[ext] || "file";
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

/* ─── Status → Chip color mapping ─── */
function statusChipProps(status) {
  if (status === "added") return { label: "added", color: "success" };
  if (status === "removed" || status === "deleted") return { label: "deleted", color: "error" };
  return { label: "modified", color: "info" };
}

/* ─── DiffFile component ─── */
function DiffFile({ file }) {
  const [expanded, setExpanded] = useState(false);
  const lines = parseDiffLines(file.patch || file.diff);
  const additions = file.additions ?? lines.filter((l) => l.type === "addition").length;
  const deletions = file.deletions ?? lines.filter((l) => l.type === "deletion").length;
  const chipProps = statusChipProps(file.status);

  return html`
    <${Accordion}
      expanded=${expanded}
      onChange=${() => setExpanded(!expanded)}
      disableGutters
      sx=${{ mb: 1, "&:before": { display: "none" } }}
    >
      <${AccordionSummary}
        sx=${{
          px: 2,
          "& .MuiAccordionSummary-content": { alignItems: "center", gap: 1 },
        }}
      >
        <span class="diff-file-icon">${fileIcon(file.filename)}</span>
        <${Typography} variant="body2" sx=${{ fontFamily: "monospace", flexGrow: 1 }}>
          ${file.filename}
        <//>
        <${Chip} label=${chipProps.label} size="small" color=${chipProps.color} variant="outlined" sx=${{ mr: 1 }} />
        <${Stack} direction="row" spacing=${0.5}>
          ${additions > 0 && html`
            <${Chip} label=${`+${additions}`} size="small" color="success" variant="outlined" />
          `}
          ${deletions > 0 && html`
            <${Chip} label=${`-${deletions}`} size="small" color="error" variant="outlined" />
          `}
        <//>
      <//>
      <${AccordionDetails} sx=${{ p: 0 }}>
        ${lines.length > 0 ? html`
          <div class="diff-hunk">
            ${lines.map(
              (line) => html`
                <div key=${line.index} class="diff-line ${line.type}">
                  <span class="diff-line-text">${line.text}</span>
                </div>
              `,
            )}
          </div>
        ` : html`
          <div class="diff-hunk">
            <div class="diff-line context">
              <span class="diff-line-text">(no diff available)</span>
            </div>
          </div>
        `}
      <//>
    <//>
  `;
}

/* ─── DiffViewer component ─── */
export function DiffViewer({ sessionId, workspace = "active", activitySummary = null }) {
  const [diffData, setDiffData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    setLoading(true);
    setError(null);
    const diffPath = buildDiffApiPath(sessionId, workspace);
    if (!diffPath) {
      setDiffData(null);
      setLoading(false);
      setError("unavailable");
      return () => { active = false; };
    }

    apiFetch(diffPath, { _silent: true })
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
  }, [sessionId, workspace]);

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    const diffPath = buildDiffApiPath(sessionId, workspace);
    if (!diffPath) {
      setLoading(false);
      setError("unavailable");
      return;
    }
    apiFetch(diffPath, { _silent: true })
      .then((res) => setDiffData(res?.diff || null))
      .catch(() => setError("unavailable"))
      .finally(() => setLoading(false));
  }, [sessionId, workspace]);

  /* ── Empty: no session selected ── */
  if (!sessionId) {
    return html`
      <${Box} className="diff-viewer" sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 6, gap: 1 }}>
        <${Typography} variant="h6" color="text.secondary">${resolveIcon(":edit:")}<//>
        <${Typography} variant="body2" color="text.secondary">Select a session to view diffs<//>
      <//>
    `;
  }

  /* ── Loading ── */
  if (loading) {
    return html`
      <${Box} className="diff-viewer" sx=${{ p: 2 }}>
        <${Skeleton} variant="rectangular" height=${200} sx=${{ borderRadius: 1 }} />
      <//>
    `;
  }

  /* ── Error ── */
  if (error) {
    return html`
      <${Box} className="diff-viewer" sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 6, gap: 1 }}>
        <${Typography} variant="h6" color="text.secondary">${resolveIcon(":edit:")}<//>
        <${Typography} variant="body2" color="text.secondary">Diff not available<//>
        <${Button} variant="contained" size="small" onClick=${handleRetry}>Retry<//>
      <//>
    `;
  }

  const files = Array.isArray(diffData?.files) ? diffData.files : [];
  const fallbackFiles = Array.isArray(activitySummary?.files)
    ? activitySummary.files
    : [];
  const usingActivityFallback = files.length === 0 && fallbackFiles.length > 0;
  const renderedFiles = usingActivityFallback
    ? fallbackFiles.map((entry) => ({
        filename: entry.path,
        status: "modified",
        additions: Number(entry.edits || 0),
        deletions: 0,
        patch: "",
      }))
    : files;
  const totalAdditions = renderedFiles.reduce(
    (n, f) => n + (f.additions ?? 0),
    0,
  );
  const totalDeletions = renderedFiles.reduce(
    (n, f) => n + (f.deletions ?? 0),
    0,
  );

  return html`
    <div class="diff-viewer">
      ${renderedFiles.length > 0 && html`
        <${Paper} variant="outlined" sx=${{ mb: 2, px: 2, py: 1 }}>
          <${Stack} direction="row" spacing=${1} alignItems="center">
            <${Typography} variant="body2">
              ${renderedFiles.length} file${renderedFiles.length !== 1 ? "s" : ""}
              ${usingActivityFallback ? " touched" : " changed"}
            <//>
            ${usingActivityFallback && html`
              <${Chip} label="activity fallback" size="small" color="warning" variant="outlined" />
            `}
            ${totalAdditions > 0 && html`
              <${Chip} label=${`+${totalAdditions}`} size="small" color="success" variant="outlined" />
            `}
            ${totalDeletions > 0 && html`
              <${Chip} label=${`-${totalDeletions}`} size="small" color="error" variant="outlined" />
            `}
          <//>
        <//>
      `}
      <div class="diff-file-list">
        ${renderedFiles.length > 0
          ? renderedFiles.map(
              (f) => html`<${DiffFile} key=${f.filename} file=${f} />`,
            )
          : html`
              <${Box} sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 6, gap: 1 }}>
                <${Typography} variant="h6" color="text.secondary">${resolveIcon(":star:")}<//>
                <${Typography} variant="body2" color="text.secondary">No changes yet<//>
              <//>
            `}
      </div>
    </div>
  `;
}
