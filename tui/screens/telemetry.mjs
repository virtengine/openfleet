import React from "react";
import htm from "htm";
import { Box, Text, useStdout } from "ink";

import { buildTelemetryModel } from "./telemetry-screen-helpers.mjs";

const html = htm.bind(React.createElement);
const WIDE_WIDTH = 140;

function panel(title, body, props = {}) {
  return html`
    <${Box} borderStyle="single" paddingX=${1} paddingY=${0} flexDirection="column" ${...props}>
      <${Text} bold color="cyan">${title}<//>
      ${body}
    <//>
  `;
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function toneColor(tone) {
  if (tone === "red") return "red";
  if (tone === "yellow") return "yellow";
  return undefined;
}

export default function TelemetryScreen({ stats, config }) {
  const { stdout } = useStdout();
  const columns = Number(stdout?.columns || 0);
  const wide = columns >= WIDE_WIDTH;
  const model = buildTelemetryModel({ stats, config });

  const throughputPanel = panel("Session Throughput", html`
    <${Text}>60s throughput ${model.sparklines.throughput || ""}<//>
    <${Text} dimColor>Provider usage ${model.sparklines.providerUsage || ""}<//>
    <${Text}>Session estimate: ${formatUsd(model.cost.sessionEstimateUsd)}<//>
    <${Text} dimColor>Cost estimates only<//>
  `, { width: wide ? "33%" : undefined, marginRight: wide ? 1 : 0, marginBottom: wide ? 0 : 1 });

  const providerPanel = panel("Token Usage by Provider", html`
    ${model.providerRows.map((row) => html`
      <${Box} key=${row.provider}>
        <${Text} color=${row.highlight || undefined}>${row.provider.padEnd(7)}<//>
        <${Text}> ${String(row.sessions).padStart(2)} sess | in ${row.tokensIn} | out ${row.tokensOut} | est ${formatUsd(row.costEstimateUsd)} | avg ${row.avgSessionLengthLabel} | err ${row.errorCount}<//>
      <//>
    `)}
    <${Text}>Day estimate: ${formatUsd(model.cost.dayEstimateUsd)}<//>
    <${Text} dimColor>Cost estimates only<//>
  `, { width: wide ? "34%" : undefined, marginRight: wide ? 1 : 0, marginBottom: wide ? 0 : 1 });

  const errorPanel = panel("Error and Retry Rates", html`
    <${Text}>Errors  ${model.sparklines.errors || ""}<//>
    <${Text}>Retries ${model.sparklines.retries || ""}<//>
    <${Box} marginTop=${1} flexWrap="wrap">
      ${model.heatmap.map((cell) => html`
        <${Box} key=${cell.hour} width=${9} marginRight=${1}>
          <${Text} color=${toneColor(cell.tone)} dimColor=${cell.tone === "dim"} inverse=${cell.isCurrentHour}>
            ${String(cell.hour).padStart(2, "0")}:${cell.label}
          <//>
        <//>
      `)}
    <//>
  `, { width: wide ? "33%" : undefined, marginBottom: 1 });

  const funnelPanel = panel("Task Completion Funnel", html`
    <${Text}>
      ${model.funnel.stages.map((stage) => `${stage.label} → ${stage.count} (${stage.conversionPct}%)`).join(" | ")}
    <//>
  `);

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box} flexDirection=${wide ? "row" : "column"}>
        ${throughputPanel}
        ${providerPanel}
        ${errorPanel}
      <//>
      ${funnelPanel}
    <//>
  `;
}
