/* ─────────────────────────────────────────────────────────────
 *  Tab: Telemetry / Usage Analytics
 *  Shows agent runs, skill invocations, MCP tool usage, activity
 *  trend chart, and top-N bar charts.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useMemo, useEffect } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  Typography, Box, Stack, Chip, Paper, TextField, InputAdornment,
  Select, MenuItem, FormControl, InputLabel, Button, IconButton, Tooltip,
  CircularProgress, Alert, Switch, FormControlLabel, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Divider, Tabs, Tab,
  LinearProgress, Skeleton, Card, CardContent,
} from "@mui/material";

import {
  telemetryErrors,
  telemetryAlerts,
  usageAnalytics,
  shreddingTelemetry,
  loadTelemetrySummary,
  loadTelemetryErrors,
  loadTelemetryExecutors,
  loadTelemetryAlerts,
  loadUsageAnalytics,
  loadShreddingTelemetry,
  scheduleRefresh,
} from "../modules/state.js";
import {
  Card as LegacyCard, EmptyState, Badge,
} from "../components/shared.js";

// ── Colour palettes ──────────────────────────────────────────────────────────

const AGENT_PALETTE = [
  "#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd", "#e879f9", "#f472b6",
];
const SKILL_PALETTE = [
  "#10b981", "#14b8a6", "#f59e0b", "#84cc16", "#2dd4bf", "#fbbf24",
];
const MCP_PALETTE = [
  "#f97316", "#fb923c", "#fbbf24", "#f43f5e", "#22d3ee", "#a3e635",
];

function paletteColor(palette, index) {
  return palette[index % palette.length];
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatCount(value) {
  if (value == null) return "–";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatRelative(isoStr) {
  if (!isoStr) return "never";
  const diff = Date.now() - Date.parse(isoStr);
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `about ${hrs} hour${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

function formatSinceDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function severityChipColor(sev = "medium") {
  const n = String(sev).toLowerCase();
  if (n === "high" || n === "critical") return "error";
  if (n === "medium") return "warning";
  return "info";
}

// ── SVG Trend Chart ──────────────────────────────────────────────────────────

/**
 * Renders smooth catmull-rom curves for each series in `seriesMap`.
 * `seriesMap` is `{ name: number[] }` aligned with `dates`.
 */
function TrendLines({ dates, seriesMap, palette }) {
  if (!dates?.length || !seriesMap) return null;
  const entries = Object.entries(seriesMap);
  if (!entries.length) return null;

  const W = 400, H = 140;
  const PL = 28, PR = 8, PT = 8, PB = 24;
  const iW = W - PL - PR;
  const iH = H - PT - PB;

  const allVals = entries.flatMap(([, v]) => v);
  const maxVal = Math.max(...allVals, 1);
  const n = dates.length;
  const xOf = (i) => PL + (n < 2 ? iW / 2 : (i / (n - 1)) * iW);
  const yOf = (v) => PT + iH - (v / maxVal) * iH;

  function smoothPath(values) {
    if (!values.length) return "";
    const pts = values.map((v, i) => [xOf(i), yOf(v)]);
    if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)},${cp2x.toFixed(1)} ${cp2y.toFixed(1)},${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  const ySteps = [0, Math.ceil(maxVal / 2), maxVal];
  const labelIdxs = n <= 3 ? [...Array(n).keys()] : [0, Math.floor(n / 2), n - 1];
  const xLabels = [...new Set(labelIdxs)].map((i) => ({
    x: xOf(i),
    label: (dates[i] || "").slice(5),
  }));

  return html`
    <svg viewBox="0 0 ${W} ${H}" class="analytics-trend-svg" aria-hidden="true"
      style="width:100%;height:auto;display:block">
      ${ySteps.map((v) => html`
        <g key=${v}>
          <line x1=${PL} y1=${yOf(v)} x2=${W - PR} y2=${yOf(v)}
            stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
          <text x=${PL - 4} y=${yOf(v) + 4} text-anchor="end"
            font-size="9" fill="var(--text-hint)">${v}</text>
        </g>
      `)}
      ${xLabels.map(({ x, label }) => html`
        <text key=${label} x=${x} y=${H - 5} text-anchor="middle"
          font-size="9" fill="var(--text-hint)">${label}</text>
      `)}
      ${entries.map(([name, values], i) => html`
        <path key=${name} d=${smoothPath(values)} fill="none"
          stroke=${paletteColor(palette, i)} stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
      `)}
    </svg>
  `;
}

function ChartLegend({ label, seriesMap, palette }) {
  const names = Object.keys(seriesMap || {});
  if (!names.length) return null;
  return html`
    <${Stack} direction="row" spacing=${1} alignItems="center" flexWrap="wrap" sx=${{ mb: 1 }}>
      <${Typography} variant="caption" color="text.secondary" sx=${{ fontWeight: 600, mr: 1 }}>${label}<//>
      ${names.map((name, i) => html`
        <${Chip}
          key=${name}
          label=${name}
          size="small"
          variant="outlined"
          sx=${{ borderColor: paletteColor(palette, i), "& .MuiChip-label": { fontSize: "0.75rem" } }}
          icon=${html`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${paletteColor(palette, i)};margin-left:8px"></span>`}
        />
      `)}
    <//>
  `;
}

// ── Bar Chart ────────────────────────────────────────────────────────────────

function TopBarChart({ items, palette, title }) {
  if (!items?.length) {
    return html`<${EmptyState} title="No data yet"
      description="Activity will appear here once tasks run." />`;
  }
  const max = items[0].count || 1;
  return html`
    <${Stack} spacing=${0.5}>
      ${items.map(({ name, count }, i) => html`
        <${Stack} key=${name} direction="row" alignItems="center" spacing=${1}>
          <${Typography} variant="caption" sx=${{ minWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title=${name}>
            ${name}
          <//>
          <${Box} sx=${{ flex: 1, bgcolor: "grey.800", borderRadius: 1, height: 8, overflow: "hidden" }}>
            <${Box} sx=${{ width: `${Math.max(2, (count / max) * 100).toFixed(1)}%`, height: "100%", bgcolor: paletteColor(palette, i), borderRadius: 1 }} />
          <//>
          <${Typography} variant="caption" color="text.secondary" sx=${{ minWidth: 28, textAlign: "right" }}>${count}<//>
        <//>
      `)}
    <//>
  `;
}

// ── Stat card (MUI Card) ─────────────────────────────────────────────────────

function AnalyticsStat({ icon, label, value }) {
  return html`
    <${Card} variant="outlined" sx=${{ minWidth: 120, flex: "1 1 0" }}>
      <${CardContent} sx=${{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
        <${Stack} direction="row" spacing=${1} alignItems="center">
          <${Typography} variant="h6" component="span">${icon}<//>
          <${Box}>
            <${Typography} variant="caption" color="text.secondary" display="block">${label}<//>
            <${Typography} variant="h6" sx=${{ lineHeight: 1.2 }}>${value}<//>
          <//>
        <//>
      <//>
    <//>
  `;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PERIODS = [
  { days: 7,  label: "7d"  },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

const TREND_TABS = ["agents", "skills", "mcp"];
const TREND_TAB_LABELS = { agents: "Agents", skills: "Skills", mcp: "MCP Tools" };

// ── Context Shredding Panel ──────────────────────────────────────────────────

const SHRED_PALETTE = ["#818cf8", "#38bdf8", "#34d399", "#fb923c", "#f472b6", "#a78bfa"];

function formatBytes(n) {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)} K`;
  return `${n}`;
}

/**
 * Mini inline sparkline SVG — no axes, just the shape of the data.
 */
function Sparkline({ values, color = "#818cf8" }) {
  if (!values?.length) return null;
  const W = 120, H = 32, PAD = 2;
  const max = Math.max(...values, 1);
  const n = values.length;
  const xOf = (i) => PAD + (n < 2 ? (W - PAD * 2) / 2 : (i / (n - 1)) * (W - PAD * 2));
  const yOf = (v) => H - PAD - ((v / max) * (H - PAD * 2));

  let d = `M ${xOf(0).toFixed(1)} ${yOf(values[0]).toFixed(1)}`;
  for (let i = 1; i < values.length; i++) {
    d += ` L ${xOf(i).toFixed(1)} ${yOf(values[i]).toFixed(1)}`;
  }

  return html`
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"
      style="display:inline-block;vertical-align:middle;opacity:0.85">
      <path d=${d} fill="none" stroke=${color} stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

/**
 * Context Shredding telemetry panel.
 * Shows: total savings, avg reduction %, daily trend, per-agent breakdown,
 * and a table of recent events.
 */
function ShreddingPanel({ period }) {
  const data = shreddingTelemetry.value;

  useEffect(() => {
    loadShreddingTelemetry(period).catch(() => {});
  }, [period]);

  if (!data) {
    return html`
      <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
        <${Typography} variant="h6" gutterBottom>✂ Context Shredding<//>
        <${EmptyState}
          title="No shredding data yet"
          description="Shredding stats will appear here once agents start running with context compression enabled."
        />
      <//>
    `;
  }

  const {
    totalEvents = 0,
    totalOriginalChars = 0,
    totalSavedChars = 0,
    avgSavedPct = 0,
    sortedDates = [],
    dailySaved = {},
    dailyCounts = {},
    topAgents = [],
    recentEvents = [],
    diagnostics = {},
  } = data;

  const sparkValues = sortedDates.map((d) => dailySaved[d] || 0);
  const sparkCounts = sortedDates.map((d) => dailyCounts[d] || 0);

  return html`
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <!-- Header -->
      <${Stack} direction="row" justifyContent="space-between" alignItems="center" sx=${{ mb: 1.5 }}>
        <${Typography} variant="h6">✂ Context Shredding<//>
        <${Chip} label="live" size="small" color="success" variant="outlined" />
      <//>

      <!-- Stat cards row -->
      <${Stack} direction=${{ xs: "column", sm: "row" }} spacing=${1.5} sx=${{ mb: 2, flexWrap: "wrap" }}>
        <${AnalyticsStat} icon="✂" label="Events" value=${formatCount(totalEvents)} />
        <${AnalyticsStat} icon="📉" label="Chars Saved"
          value=${totalSavedChars >= 1_000_000
            ? `${(totalSavedChars / 1_000_000).toFixed(2)} M`
            : totalSavedChars >= 1_000
              ? `${(totalSavedChars / 1_000).toFixed(1)} K`
              : String(totalSavedChars)} />
        <${AnalyticsStat} icon="%" label="Avg Reduction" value=${avgSavedPct > 0 ? `${avgSavedPct}%` : "–"} />
        <${AnalyticsStat} icon="📦" label="Original Chars"
          value=${totalOriginalChars >= 1_000_000
            ? `${(totalOriginalChars / 1_000_000).toFixed(2)} M`
            : totalOriginalChars >= 1_000
              ? `${(totalOriginalChars / 1_000).toFixed(1)} K`
              : String(totalOriginalChars)} />
      <//>

      ${(diagnostics?.excludedSynthetic || diagnostics?.excludedNoop || diagnostics?.unknownAttribution)
        ? html`
          <${Alert} severity="info" sx=${{ mb: 2 }}>
            Showing effective shredding events only.
            ${diagnostics?.excludedSynthetic ? ` Filtered synthetic/test events: ${diagnostics.excludedSynthetic}.` : ""}
            ${diagnostics?.excludedNoop ? ` Filtered no-op events: ${diagnostics.excludedNoop}.` : ""}
            ${diagnostics?.unknownAttribution ? ` Unattributed events in view: ${diagnostics.unknownAttribution}.` : ""}
          <//>
        `
        : null}

      <!-- Trend row: daily savings sparkline + by-agent bar -->
      <${Stack} direction=${{ xs: "column", md: "row" }} spacing=${2} sx=${{ mb: 2 }}>

        <!-- Daily savings trend -->
        <${Paper} variant="outlined" sx=${{ p: 1.5, flex: 1 }}>
          <${Typography} variant="subtitle2" gutterBottom>Chars Saved per Day<//>
          ${sparkValues.length > 1 ? html`
            <${Box} sx=${{ overflow: "hidden" }}>
              <${TrendLines}
                dates=${sortedDates}
                seriesMap=${{ "chars saved": sparkValues }}
                palette=${SHRED_PALETTE}
              />
            <//>
          ` : html`<${EmptyState} title="Not enough data" description="Need ≥2 days of events." />`}
        <//>

        <!-- By-agent -->
        <${Paper} variant="outlined" sx=${{ p: 1.5, flex: 1 }}>
          <${Typography} variant="subtitle2" gutterBottom>By Agent Type<//>
          <${TopBarChart} items=${topAgents} palette=${SHRED_PALETTE} title="By Agent" />
        <//>

      <//>

      <!-- Reduction % gauge bar -->
      ${avgSavedPct > 0 ? html`
        <${Box} sx=${{ mb: 2 }}>
          <${Stack} direction="row" justifyContent="space-between" alignItems="center" sx=${{ mb: 0.5 }}>
            <${Typography} variant="caption" color="text.secondary">Context Reduction<//>
            <${Typography} variant="caption" sx=${{ fontWeight: 600 }}>${avgSavedPct}% avg<//>
          <//>
          <${LinearProgress}
            variant="determinate"
            value=${Math.min(avgSavedPct, 100)}
            sx=${{
              height: 8, borderRadius: 4,
              bgcolor: "grey.800",
              "& .MuiLinearProgress-bar": { bgcolor: "#818cf8" },
            }}
          />
        <//>
      ` : null}

      <!-- Recent events table -->
      ${recentEvents.length > 0 ? html`
        <${Typography} variant="subtitle2" gutterBottom>Recent Shredding Events<//>
        <${TableContainer}>
          <${Table} size="small">
            <${TableHead}>
              <${TableRow}>
                <${TableCell}>Time<//>
                <${TableCell} align="right">Original<//>
                <${TableCell} align="right">Saved<//>
                <${TableCell} align="right">Reduction<//>
                <${TableCell}>Agent<//>
              </${TableRow}>
            <//>
            <${TableBody}>
              ${recentEvents.slice(0, 10).map((ev, i) => html`
                <${TableRow} key=${i}>
                  <${TableCell}>
                    <${Typography} variant="caption">${formatRelative(ev.timestamp)}<//>
                  <//>
                  <${TableCell} align="right">
                    <${Typography} variant="caption">${formatBytes(ev.originalChars)}<//>
                  <//>
                  <${TableCell} align="right">
                    <${Typography} variant="caption" color="success.main">
                      ${ev.savedChars > 0 ? `-${formatBytes(ev.savedChars)}` : "0"}
                    <//>
                  <//>
                  <${TableCell} align="right">
                    <${Chip}
                      label=${`${ev.savedPct || 0}%`}
                      size="small"
                      color=${ev.savedPct >= 30 ? "success" : ev.savedPct >= 10 ? "warning" : "default"}
                      variant="outlined"
                    />
                  <//>
                  <${TableCell}>
                    <${Typography} variant="caption" color="text.secondary">
                      ${ev.agentType || "–"}
                    <//>
                  <//>
                </${TableRow}>
              `)}
            <//>
          <//>
        <//>
      ` : null}
    <//>
  `;
}

// ── Main exported component ──────────────────────────────────────────────────

export function TelemetryTab() {
  const data = usageAnalytics.value;
  const [period, setPeriod] = useState(30);
  const [trendTab, setTrendTab] = useState("agents");

  useEffect(() => {
    loadUsageAnalytics(period).catch(() => {});
    loadShreddingTelemetry(period).catch(() => {});
  }, [period]);

  const trend = data?.trend;

  const trendSeriesMap = useMemo(() => {
    if (!trend) return null;
    if (trendTab === "agents") return trend.agents || {};
    if (trendTab === "skills") return trend.skills || {};
    return trend.mcpTools || {};
  }, [trend, trendTab]);

  const trendPalette =
    trendTab === "agents" ? AGENT_PALETTE
    : trendTab === "skills" ? SKILL_PALETTE
    : MCP_PALETTE;

  const hasTrend = trend?.dates?.length > 0 &&
    Object.keys(trendSeriesMap || {}).length > 0;

  const sinceLabel = formatSinceDate(data?.sinceAt);

  const trendTabIndex = TREND_TABS.indexOf(trendTab);

  return html`
    <section class="telemetry-tab analytics-tab">

      <!-- Header row -->
      <${Stack} direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" sx=${{ mb: 2 }}>
        <${Box}>
          <${Typography} variant="h5" component="h2">Usage Analytics<//>
          ${sinceLabel ? html`
            <${Typography} variant="caption" color="text.secondary">Since ${sinceLabel}<//>
          ` : null}
        <//>
        <${Stack} direction="row" spacing=${1} alignItems="center">
          <!-- Period toggle chips -->
          ${PERIODS.map(({ days, label }) => html`
            <${Chip}
              key=${days}
              label=${label}
              size="small"
              color=${period === days ? "primary" : "default"}
              variant=${period === days ? "filled" : "outlined"}
              onClick=${() => setPeriod(days)}
              clickable
            />
          `)}
          <${Button} size="small" variant="outlined" onClick=${() => {
            loadUsageAnalytics(period).catch(() => {});
            loadShreddingTelemetry(period).catch(() => {});
            loadTelemetrySummary();
            loadTelemetryErrors();
            loadTelemetryExecutors();
            loadTelemetryAlerts();
            scheduleRefresh(4000);
          }}>Refresh<//>
        <//>
      <//>

      <!-- Summary stat cards -->
      <${Stack} direction="row" spacing=${1.5} sx=${{ mb: 2, flexWrap: "wrap" }}>
        <${AnalyticsStat} icon="⚡" label="Agent Runs"
          value=${data ? formatCount(data.agentRuns) : "–"} />
        <${AnalyticsStat} icon="✦" label="Skill Invocations"
          value=${data ? formatCount(data.skillInvocations) : "–"} />
        <${AnalyticsStat} icon="⚙" label="MCP Tools"
          value=${data ? formatCount(data.mcpToolCalls) : "–"} />
        <${AnalyticsStat} icon="≈" label="Avg / Day"
          value=${data ? formatCount(data.avgPerDay) : "–"} />
        <${AnalyticsStat} icon="🕐" label="Last Active"
          value=${data?.lastActiveAt ? formatRelative(data.lastActiveAt) : "–"} />
      <//>

      <!-- Activity trend chart -->
      <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
        <${Typography} variant="h6" gutterBottom>Activity Trend<//>

        <!-- Trend tabs using MUI Tabs -->
        <${Tabs}
          value=${trendTabIndex >= 0 ? trendTabIndex : 0}
          onChange=${(_e, idx) => setTrendTab(TREND_TABS[idx])}
          variant="scrollable"
          scrollButtons="auto"
          sx=${{ mb: 1.5 }}
        >
          ${TREND_TABS.map((tab) => html`
            <${Tab} key=${tab} label=${TREND_TAB_LABELS[tab] || tab} />
          `)}
        <//>

        ${hasTrend ? html`
          <${ChartLegend}
            label=${(TREND_TAB_LABELS[trendTab] || trendTab).toUpperCase()}
            seriesMap=${trendSeriesMap}
            palette=${trendPalette}
          />
          <${Paper} variant="outlined" sx=${{ p: 1 }}>
            <${TrendLines} dates=${trend.dates} seriesMap=${trendSeriesMap} palette=${trendPalette} />
          <//>
        ` : html`
          <${EmptyState} title="No activity data"
            description="Agent runs will appear here once they start." />
        `}
      <//>

      <!-- Top-N bar charts row -->
      <${Stack} direction=${{ xs: "column", md: "row" }} spacing=${2} sx=${{ mb: 2 }}>
        <${Paper} elevation=${1} sx=${{ p: 2, flex: 1 }}>
          <${Typography} variant="h6" gutterBottom>Top Agents<//>
          <${TopBarChart} items=${data?.topAgents || []}
            palette=${AGENT_PALETTE} title="Top Agents" />
        <//>
        <${Paper} elevation=${1} sx=${{ p: 2, flex: 1 }}>
          <${Typography} variant="h6" gutterBottom>Top Skills<//>
          <${TopBarChart} items=${data?.topSkills || []}
            palette=${SKILL_PALETTE} title="Top Skills" />
        <//>
        <${Paper} elevation=${1} sx=${{ p: 2, flex: 1 }}>
          <${Typography} variant="h6" gutterBottom>Top MCP Tools<//>
          <${TopBarChart} items=${data?.topMcpTools || []}
            palette=${MCP_PALETTE} title="Top MCP Tools" />
        <//>
      <//>

      <!-- Context Shredding Panel -->
      <${ShreddingPanel} period=${period} />

      <!-- Errors + alerts (preserved from classic telemetry) -->
      <${ClassicTelemetry} />
    </section>
  `;
}

// ── Classic error/alert section ──────────────────────────────────────────────

function ClassicTelemetry() {
  const errors = telemetryErrors.value || [];
  const alerts = telemetryAlerts.value || [];
  const alertRows = useMemo(() => alerts.slice(-10).reverse(), [alerts]);
  if (!errors.length && !alerts.length) return null;

  return html`
    <${Stack} direction=${{ xs: "column", md: "row" }} spacing=${2}>
      <!-- Top Errors -->
      <${Paper} elevation=${1} sx=${{ p: 2, flex: 1 }}>
        <${Typography} variant="h6" gutterBottom>Top Errors<//>
        ${errors.length === 0
          ? html`<${EmptyState} title="No errors logged"
              description="Errors appear here when failures are detected." />`
          : html`
            <${TableContainer}>
              <${Table} size="small">
                <${TableHead}>
                  <${TableRow}>
                    <${TableCell}>Fingerprint<//>
                    <${TableCell} align="right">Count<//>
                  </${TableRow}>
                <//>
                <${TableBody}>
                  ${errors.slice(0, 8).map((err) => html`
                    <${TableRow} key=${err.fingerprint}>
                      <${TableCell}>
                        <${Typography} variant="body2" sx=${{ fontFamily: "monospace" }}>${err.fingerprint}<//>
                      <//>
                      <${TableCell} align="right">
                        <${Chip} label=${String(err.count)} size="small" color="error" />
                      <//>
                    </${TableRow}>
                  `)}
                <//>
              </${Table}>
            <//>
          `}
      <//>

      <!-- Recent Alerts -->
      <${Paper} elevation=${1} sx=${{ p: 2, flex: 1 }}>
        <${Typography} variant="h6" gutterBottom>Recent Alerts<//>
        ${alertRows.length === 0
          ? html`<${EmptyState} title="No alerts"
              description="Analyzer alerts will show up here." />`
          : html`
            <${Stack} spacing=${1}>
              ${alertRows.map((alert) => html`
                <${Paper} key=${(alert.attempt_id || "") + (alert.type || "")} variant="outlined" sx=${{ p: 1.5 }}>
                  <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 0.5 }}>
                    <${Typography} variant="subtitle2">${alert.type || "alert"}<//>
                    <${Chip}
                      label=${String(alert.severity || "medium").toUpperCase()}
                      size="small"
                      color=${severityChipColor(alert.severity)}
                    />
                  <//>
                  <${Typography} variant="caption" color="text.secondary">
                    ${alert.attempt_id || "unknown"}${alert.executor ? ` · ${alert.executor}` : ""}
                  <//>
                <//>
              `)}
            <//>
          `}
      <//>
    <//>
  `;
}
