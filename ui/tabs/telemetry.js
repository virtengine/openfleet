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
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Telemetry</h2>
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
        : html`<${Card} title="Summary">
            <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div class="flex flex-col">
                <div class="text-xs uppercase opacity-60">Sessions</div>
                <div class="text-xl font-bold">${formatCount(summary.total)}</div>
              </div>
              <div class="flex flex-col">
                <div class="text-xs uppercase opacity-60">Success</div>
                <div class="text-xl font-bold">
                  ${formatCount(summary.success)} (${summary.successRate}%)
                </div>
              </div>
              <div class="flex flex-col">
                <div class="text-xs uppercase opacity-60">Avg Duration</div>
                <div class="text-xl font-bold">${formatSeconds(summary.avgDuration)}</div>
              </div>
              <div class="flex flex-col">
                <div class="text-xs uppercase opacity-60">Errors</div>
                <div class="text-xl font-bold">${formatCount(summary.totalErrors)}</div>
              </div>
            </div>
          </${Card}>`}

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <${Card} title="Top Errors">
          ${errors.length === 0
            ? html`<${EmptyState}
                title="No errors logged"
                description="Errors appear here when failures are detected."
              />`
            : html`<ul class="flex flex-col gap-1">
                ${errors.slice(0, 8).map(
                  (err) => html`<li class="flex items-center justify-between px-2 py-1 rounded-lg hover:bg-base-200 transition-colors">
                    <span class="text-sm truncate">${err.fingerprint}</span>
                    <span class="badge badge-sm badge-ghost">${err.count}</span>
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
            : html`<ul class="flex flex-col gap-1">
                ${executorRows.map(
                  ([name, count]) => html`<li class="flex items-center justify-between px-2 py-1 rounded-lg hover:bg-base-200 transition-colors">
                    <span class="text-sm truncate">${name}</span>
                    <span class="badge badge-sm badge-ghost">${count}</span>
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
          : html`<ul class="flex flex-col gap-2">
              ${alertRows.map(
                (alert) => html`<li class="flex flex-col gap-1 px-3 py-2 rounded-lg hover:bg-base-200 transition-colors">
                  <div>
                    <div class="flex items-center gap-2 text-sm font-medium">
                      ${alert.type || "alert"}
                      <${Badge} tone=${severityBadge(alert.severity)}>${
                        String(alert.severity || "medium").toUpperCase()
                      }</${Badge}>
                    </div>
                    <div class="text-xs opacity-60">
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

