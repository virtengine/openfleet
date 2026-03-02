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
  loadTelemetrySummary,
  loadTelemetryErrors,
  loadTelemetryExecutors,
  loadTelemetryAlerts,
  loadUsageAnalytics,
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

// ── Main exported component ──────────────────────────────────────────────────

export function TelemetryTab() {
  const data = usageAnalytics.value;
  const [period, setPeriod] = useState(30);
  const [trendTab, setTrendTab] = useState("agents");

  useEffect(() => {
    loadUsageAnalytics(period).catch(() => {});
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
