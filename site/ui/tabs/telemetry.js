/* ─────────────────────────────────────────────────────────────
 *  Tab: Telemetry — analytics, quality signals, alerts
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  telemetrySummary,
  telemetryErrors,
  telemetryExecutors,
  telemetryAlerts,
  loadTelemetrySummary,
  loadTelemetryErrors,
  loadTelemetryExecutors,
  loadTelemetryAlerts,
  scheduleRefresh,
} from "../modules/state.js";
import { Card, EmptyState, SkeletonCard, Badge } from "../components/shared.js";

function formatCount(value) {
  if (value == null) return "–";
  return String(value);
}

function formatSeconds(value) {
  if (!value && value !== 0) return "–";
  if (value >= 60) return `${Math.round(value / 60)}m`;
  return `${value}s`;
}

function severityBadge(sev = "medium") {
  const normalized = String(sev).toLowerCase();
  if (normalized === "high" || normalized === "critical") return "danger";
  if (normalized === "medium") return "warning";
  return "info";
}

export function TelemetryTab() {
  const summary = telemetrySummary.value;
  const errors = telemetryErrors.value || [];
  const executors = telemetryExecutors.value || {};
  const alerts = telemetryAlerts.value || [];

  const hasSummary = summary && summary.total > 0;

  const executorRows = useMemo(
    () => Object.entries(executors).sort((a, b) => b[1] - a[1]),
    [executors],
  );

  const alertRows = useMemo(
    () => alerts.slice(-10).reverse(),
    [alerts],
  );

  return html`
    <section class="telemetry-tab">
      <div class="section-header">
        <h2>Telemetry</h2>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => {
            loadTelemetrySummary();
            loadTelemetryErrors();
            loadTelemetryExecutors();
            loadTelemetryAlerts();
            scheduleRefresh(4000);
          }}
        >
          Refresh
        </button>
      </div>

      ${!hasSummary
        ? html`<${EmptyState}
            title="No telemetry yet"
            description="Telemetry appears here once agents start running."
          />`
        : html`<${Card} title="Summary" class="telemetry-summary">
            <div class="metric-grid">
              <div>
                <div class="metric-label">Sessions</div>
                <div class="metric-value">${formatCount(summary.total)}</div>
              </div>
              <div>
                <div class="metric-label">Success</div>
                <div class="metric-value">
                  ${formatCount(summary.success)} (${summary.successRate}%)
                </div>
              </div>
              <div>
                <div class="metric-label">Avg Duration</div>
                <div class="metric-value">${formatSeconds(summary.avgDuration)}</div>
              </div>
              <div>
                <div class="metric-label">Errors</div>
                <div class="metric-value">${formatCount(summary.totalErrors)}</div>
              </div>
            </div>
          </${Card}>`}

      <div class="telemetry-grid">
        <${Card} title="Top Errors">
          ${errors.length === 0
            ? html`<${EmptyState}
                title="No errors logged"
                description="Errors appear here when failures are detected."
              />`
            : html`<ul class="telemetry-list">
                ${errors.slice(0, 8).map(
                  (err) => html`<li>
                    <span class="telemetry-label">${err.fingerprint}</span>
                    <span class="telemetry-count">${err.count}</span>
                  </li>`,
                )}
              </ul>`}
        </${Card}>

        <${Card} title="Executors">
          ${executorRows.length === 0
            ? html`<${EmptyState}
                title="No executor data"
                description="Run tasks to populate executor usage."
              />`
            : html`<ul class="telemetry-list">
                ${executorRows.map(
                  ([name, count]) => html`<li>
                    <span class="telemetry-label">${name}</span>
                    <span class="telemetry-count">${count}</span>
                  </li>`,
                )}
              </ul>`}
        </${Card}>
      </div>

      <${Card} title="Recent Alerts">
        ${alertRows.length === 0
          ? html`<${EmptyState}
              title="No alerts"
              description="Analyzer alerts will show up here."
            />`
          : html`<ul class="telemetry-alerts">
              ${alertRows.map(
                (alert) => html`<li>
                  <div>
                    <div class="telemetry-alert-title">
                      ${alert.type || "alert"}
                      <${Badge} tone=${severityBadge(alert.severity)}>${
                        String(alert.severity || "medium").toUpperCase()
                      }</${Badge}>
                    </div>
                    <div class="telemetry-alert-meta">
                      ${alert.attempt_id || "unknown"}
                      ${alert.executor ? html` · ${alert.executor}` : ""}
                    </div>
                  </div>
                </li>`,
              )}
            </ul>`}
      </${Card}>
    </section>
  `;
}

