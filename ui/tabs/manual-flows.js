/* ─────────────────────────────────────────────────────────────
 *  Tab: Manual Flows — One-shot template-driven transformations
 *  + Workflow Launcher — trigger any automatic workflow with custom params
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";
import { formatDate, formatDuration, formatRelative } from "../modules/utils.js";
import { ICONS } from "../modules/icons.js";
import { resolveIcon } from "../modules/icon-utils.js";
import {
  Typography, Box, Stack, Card, CardContent, Button, IconButton, Chip,
  TextField, Select, MenuItem, FormControl, InputLabel, Switch,
  FormControlLabel, Tooltip, Paper, Divider, CircularProgress, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Tabs, Tab, LinearProgress, Collapse, Badge, Fade,
} from "@mui/material";

/* ═══════════════════════════════════════════════════════════════
 *  State
 * ═══════════════════════════════════════════════════════════════ */

const flowTemplates = signal([]);
const flowRuns = signal([]);
const selectedTemplate = signal(null);
const activeRun = signal(null);
const viewMode = signal("templates"); // "templates" | "form" | "runs" | "wf-launcher" | "wf-form"
const executing = signal(false);

// ── Top-level tab (Manual Flows vs Workflow Launcher) ──
const activeTab = signal(0); // 0 = Manual Flows, 1 = Workflow Launcher

// ── Workflow Launcher state ──
const wfTemplates = signal([]);
const selectedWfTemplate = signal(null);
const wfLaunching = signal(false);
const wfLaunchResult = signal(null);
const wfSearchQuery = signal("");
const wfSelectedCategory = signal("all");
const wfManualRuns = signal([]);
const selectedWfRunId = signal(null);
const selectedWfRunDetail = signal(null);
const wfManualRunsLoading = signal(false);

const MANUAL_WORKFLOW_RUN_PAGE_SIZE = 100;

function isManualWorkflowRun(run) {
  const triggerSource = String(run?.triggerSource || "manual").trim().toLowerCase();
  return triggerSource === "manual" || triggerSource === "ui-event";
}

async function loadManualWorkflowRuns(limit = MANUAL_WORKFLOW_RUN_PAGE_SIZE) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), 300)
    : MANUAL_WORKFLOW_RUN_PAGE_SIZE;
  wfManualRunsLoading.value = true;
  try {
    const data = await apiFetch(`/api/workflows/runs?limit=${safeLimit}`);
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    wfManualRuns.value = runs.filter((run) => isManualWorkflowRun(run));
  } catch (err) {
    console.error("[manual-flows] Failed to load manual workflow runs:", err);
    wfManualRuns.value = [];
  } finally {
    wfManualRunsLoading.value = false;
  }
}

async function loadManualWorkflowRunDetail(runId) {
  const safeRunId = String(runId || "").trim();
  if (!safeRunId) return null;
  try {
    const data = await apiFetch(`/api/workflows/runs/${encodeURIComponent(safeRunId)}`);
    if (data?.run) {
      selectedWfRunId.value = safeRunId;
      selectedWfRunDetail.value = data.run;
      return data.run;
    }
  } catch (err) {
    console.error("[manual-flows] Failed to load run detail:", err);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function loadTemplates() {
  try {
    const data = await apiFetch("/api/manual-flows/templates");
    if (data?.templates) flowTemplates.value = data.templates;
  } catch (err) {
    console.error("[manual-flows] Failed to load templates:", err);
  }
}

async function loadRuns() {
  try {
    const data = await apiFetch("/api/manual-flows/runs");
    if (data?.runs) flowRuns.value = data.runs;
  } catch (err) {
    console.error("[manual-flows] Failed to load runs:", err);
  }
}

async function executeFlow(templateId, formValues) {
  executing.value = true;
  try {
    const data = await apiFetch("/api/manual-flows/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, formValues }),
    });
    if (data?.run) {
      activeRun.value = data.run;
      showToast(
        data.run.status === "completed"
          ? "Flow completed successfully"
          : data.run.status === "failed"
          ? "Flow failed: " + (data.run.error || "unknown error")
          : "Flow dispatched",
        data.run.status === "failed" ? "error" : "success",
      );
      loadRuns().catch(() => {});
    }
    return data?.run;
  } catch (err) {
    showToast("Failed to execute flow: " + err.message, "error");
    return null;
  } finally {
    executing.value = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Workflow Launcher API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function loadWfTemplates() {
  try {
    const data = await apiFetch("/api/workflows/templates");
    if (data?.templates) wfTemplates.value = data.templates;
  } catch (err) {
    console.error("[manual-flows] Failed to load workflow templates:", err);
  }
}

async function launchWorkflowTemplate(templateId, variables) {
  wfLaunching.value = true;
  wfLaunchResult.value = null;
  try {
    const data = await apiFetch("/api/workflows/launch-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, variables }),
    });
    wfLaunchResult.value = data;
    showToast(
      data?.accepted
        ? `Workflow "${data.templateName}" dispatched`
        : `Workflow "${data?.templateName || templateId}" completed`,
      "success",
    );
    return data;
  } catch (err) {
    wfLaunchResult.value = { ok: false, error: err.message };
    showToast("Failed to launch workflow: " + err.message, "error");
    return null;
  } finally {
    wfLaunching.value = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Category metadata
 * ═══════════════════════════════════════════════════════════════ */

const CATEGORY_META = {
  audit: { label: "Audit & Analysis", icon: "search", color: "#3b82f6", bg: "#3b82f615" },
  generate: { label: "Generate & Prepare", icon: "book", color: "#10b981", bg: "#10b98115" },
  transform: { label: "Transform & Refactor", icon: "refresh", color: "#f59e0b", bg: "#f59e0b15" },
  custom: { label: "Custom", icon: "settings", color: "#8b5cf6", bg: "#8b5cf615" },
};

// ── Workflow template category colors ──
const WF_CATEGORY_META = {
  github:      { label: "GitHub",       icon: "git-branch",  color: "#6e5494", bg: "#6e549415" },
  agents:      { label: "Agents",       icon: "robot",       color: "#3b82f6", bg: "#3b82f615" },
  planning:    { label: "Planning",     icon: "calendar",    color: "#10b981", bg: "#10b98115" },
  cicd:        { label: "CI/CD",        icon: "rocket",      color: "#f59e0b", bg: "#f59e0b15" },
  reliability: { label: "Reliability",  icon: "shield",      color: "#ef4444", bg: "#ef444415" },
  security:    { label: "Security",     icon: "lock",        color: "#dc2626", bg: "#dc262615" },
  lifecycle:   { label: "Lifecycle",    icon: "refresh",     color: "#8b5cf6", bg: "#8b5cf615" },
  research:    { label: "Research",     icon: "search",      color: "#06b6d4", bg: "#06b6d415" },
  custom:      { label: "Custom",       icon: "settings",    color: "#6b7280", bg: "#6b728015" },
};

function getCategoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.custom;
}

/* ═══════════════════════════════════════════════════════════════
 *  Form Field Renderer
 * ═══════════════════════════════════════════════════════════════ */

function FormField({ field, value, onChange }) {
  const { id, label, type, placeholder, helpText, options, defaultValue } = field;
  const currentValue = value !== undefined ? value : (defaultValue ?? "");

  switch (type) {
    case "text":
      return html`
        <${TextField}
          fullWidth
          size="small"
          label=${label}
          placeholder=${placeholder || ""}
          value=${currentValue}
          onChange=${(e) => onChange(id, e.target.value)}
          helperText=${helpText || ""}
          sx=${{ mb: 2 }}
        />
      `;

    case "textarea":
      return html`
        <${TextField}
          fullWidth
          multiline
          rows=${4}
          size="small"
          label=${label}
          placeholder=${placeholder || ""}
          value=${currentValue}
          onChange=${(e) => onChange(id, e.target.value)}
          helperText=${helpText || ""}
          sx=${{ mb: 2, "& .MuiInputBase-input": { fontFamily: "monospace", fontSize: "0.85em" } }}
        />
      `;

    case "number":
      return html`
        <${TextField}
          fullWidth
          size="small"
          type="number"
          label=${label}
          placeholder=${placeholder || ""}
          value=${currentValue}
          onChange=${(e) => onChange(id, Number(e.target.value))}
          helperText=${helpText || ""}
          sx=${{ mb: 2 }}
        />
      `;

    case "select":
      return html`
        <${FormControl} fullWidth size="small" sx=${{ mb: 2 }}>
          <${InputLabel}>${label}</${InputLabel}>
          <${Select}
            label=${label}
            value=${currentValue}
            onChange=${(e) => onChange(id, e.target.value)}
          >
            ${(options || []).map(
              (opt) => html`<${MenuItem} key=${opt.value} value=${opt.value}>${opt.label}</${MenuItem}>`,
            )}
          </${Select}>
          ${helpText && html`<${Typography} variant="caption" color="text.secondary" sx=${{ mt: 0.5, ml: 1.5 }}>${helpText}</${Typography}>`}
        </${FormControl}>
      `;

    case "toggle":
      return html`
        <${Box} sx=${{ mb: 2 }}>
          <${FormControlLabel}
            control=${html`<${Switch}
              checked=${!!currentValue}
              onChange=${(e) => onChange(id, e.target.checked)}
              size="small"
            />`}
            label=${label}
          />
          ${helpText && html`<${Typography} variant="caption" display="block" color="text.secondary" sx=${{ ml: 4.5, mt: -0.5 }}>${helpText}</${Typography}>`}
        </${Box}>
      `;

    default:
      return html`
        <${TextField}
          fullWidth
          size="small"
          label=${label}
          value=${currentValue}
          onChange=${(e) => onChange(id, e.target.value)}
          helperText=${helpText || ""}
          sx=${{ mb: 2 }}
        />
      `;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Template Card
 * ═══════════════════════════════════════════════════════════════ */

function TemplateCard({ template, onClick }) {
  const catMeta = getCategoryMeta(template.category);

  return html`
    <${Card}
      variant="outlined"
      sx=${{
        cursor: "pointer",
        transition: "all 0.15s",
        "&:hover": { borderColor: catMeta.color, transform: "translateY(-1px)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" },
      }}
      onClick=${onClick}
    >
      <${CardContent} sx=${{ pb: "12px !important" }}>
        <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
          <span class="icon-inline" style=${{ fontSize: "18px", color: catMeta.color }}>
            ${resolveIcon(template.icon || catMeta.icon)}
          </span>
          <${Typography} variant="subtitle1" fontWeight=${600} sx=${{ flex: 1 }}>
            ${template.name}
          </${Typography}>
          ${template.builtin && html`
            <${Chip} label="Built-in" size="small" variant="outlined" sx=${{ fontSize: "10px", height: "20px" }} />
          `}
        </${Stack}>

        <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1.5, lineHeight: 1.5 }}>
          ${template.description}
        </${Typography}>

        <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" useFlexGap>
          <${Chip}
            label=${catMeta.label}
            size="small"
            sx=${{ fontSize: "10px", height: "20px", background: catMeta.bg, color: catMeta.color, borderColor: catMeta.color + "40" }}
            variant="outlined"
          />
          <${Chip}
            label=${`${(template.fields || []).length} fields`}
            size="small"
            sx=${{ fontSize: "10px", height: "20px" }}
            variant="outlined"
          />
          ${(template.tags || []).slice(0, 3).map(
            (tag) => html`<${Chip} key=${tag} label=${tag} size="small" sx=${{ fontSize: "10px", height: "20px" }} variant="outlined" />`,
          )}
        </${Stack}>
      </${CardContent}>
    </${Card}>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Flow Form View
 * ═══════════════════════════════════════════════════════════════ */

function FlowFormView({ template, onBack }) {
  const [formValues, setFormValues] = useState(() => {
    const defaults = {};
    for (const field of template.fields || []) {
      if (field.defaultValue !== undefined) {
        defaults[field.id] = field.defaultValue;
      }
    }
    return defaults;
  });

  const handleFieldChange = useCallback((fieldId, value) => {
    setFormValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const handleExecute = useCallback(async () => {
    haptic();
    const run = await executeFlow(template.id, formValues);
    if (run) {
      activeRun.value = run;
    }
  }, [template.id, formValues]);

  const catMeta = getCategoryMeta(template.category);

  return html`
    <div>
      <!-- Back button -->
      <${Button}
        variant="text"
        size="small"
        onClick=${() => { onBack(); activeRun.value = null; }}
        sx=${{ mb: 2, textTransform: "none" }}
        startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
      >
        Back to Templates
      </${Button}>

      <!-- Template header -->
      <${Paper} variant="outlined" sx=${{ p: 2.5, mb: 3 }}>
        <${Stack} direction="row" alignItems="center" spacing=${1.5} sx=${{ mb: 1.5 }}>
          <span class="icon-inline" style=${{ fontSize: "24px", color: catMeta.color }}>
            ${resolveIcon(template.icon || catMeta.icon)}
          </span>
          <div>
            <${Typography} variant="h6" fontWeight=${700}>${template.name}</${Typography}>
            <${Typography} variant="body2" color="text.secondary">${template.description}</${Typography}>
          </div>
        </${Stack}>
      </${Paper}>

      <!-- Form fields -->
      <${Paper} variant="outlined" sx=${{ p: 2.5, mb: 3 }}>
        <${Typography} variant="subtitle2" fontWeight=${600} sx=${{ mb: 2 }}>
          Configuration
        </${Typography}>

        ${(template.fields || []).map(
          (field) => html`
            <${FormField}
              key=${field.id}
              field=${field}
              value=${formValues[field.id]}
              onChange=${handleFieldChange}
            />
          `,
        )}

        <${Divider} sx=${{ my: 2 }} />

        <${Stack} direction="row" spacing=${1.5} justifyContent="flex-end">
          <${Button}
            variant="outlined"
            size="small"
            onClick=${() => { onBack(); activeRun.value = null; }}
            sx=${{ textTransform: "none" }}
          >
            Cancel
          </${Button}>
          <${Button}
            variant="contained"
            onClick=${handleExecute}
            disabled=${executing.value}
            startIcon=${executing.value
              ? html`<${CircularProgress} size=${16} color="inherit" />`
              : html`<span class="icon-inline">${resolveIcon("play")}</span>`}
            sx=${{ textTransform: "none" }}
          >
            ${executing.value ? "Executing…" : "Run Flow"}
          </${Button}>
        </${Stack}>
      </${Paper}>

      <!-- Run result (if available) -->
      ${activeRun.value && html`<${RunResultCard} run=${activeRun.value} />`}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Run Result Card
 * ═══════════════════════════════════════════════════════════════ */

function RunResultCard({ run }) {
  if (!run) return null;

  const statusColors = {
    pending: "#f59e0b",
    running: "#3b82f6",
    completed: "#10b981",
    failed: "#ef4444",
  };
  const statusColor = statusColors[run.status] || "#6b7280";

  return html`
    <${Paper} variant="outlined" sx=${{ p: 2.5, borderColor: statusColor + "40" }}>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5 }}>
        <${Chip}
          label=${run.status}
          size="small"
          sx=${{
            background: statusColor + "20",
            color: statusColor,
            fontWeight: 600,
            fontSize: "11px",
            textTransform: "uppercase",
          }}
        />
        <${Typography} variant="body2" color="text.secondary">
          ${run.templateName}
        </${Typography}>
        <div style="flex: 1;" />
        <${Typography} variant="caption" color="text.secondary">
          ${formatRelative(run.startedAt)}
        </${Typography}>
      </${Stack}>

      ${run.error && html`
        <${Alert} severity="error" sx=${{ mb: 1.5 }}>
          ${run.error}
        </${Alert}>
      `}

      ${run.result && html`
        <div>
          ${run.result.mode && html`
            <${Typography} variant="body2" sx=${{ mb: 1 }}>
              <strong>Mode:</strong> ${run.result.mode}
            </${Typography}>
          `}
          ${run.result.filesScanned != null && html`
            <${Typography} variant="body2" sx=${{ mb: 0.5 }}>
              <strong>Files scanned:</strong> ${run.result.filesScanned}
            </${Typography}>
          `}
          ${run.result.filesNeedingSummary != null && html`
            <${Typography} variant="body2" sx=${{ mb: 0.5 }}>
              <strong>Files needing summary:</strong> ${run.result.filesNeedingSummary}
            </${Typography}>
          `}
          ${run.result.filesNeedingWarn != null && html`
            <${Typography} variant="body2" sx=${{ mb: 0.5 }}>
              <strong>Files needing warnings:</strong> ${run.result.filesNeedingWarn}
            </${Typography}>
          `}
          ${run.result.taskId && html`
            <${Alert} severity="info" sx=${{ mt: 1 }}>
              Task dispatched: ${run.result.taskId}
            </${Alert}>
          `}
          ${run.result.instructions && html`
            <${Alert} severity="info" sx=${{ mt: 1 }}>
              ${run.result.instructions}
            </${Alert}>
          `}
          ${run.result.inventoryPath && html`
            <${Typography} variant="caption" color="text.secondary" sx=${{ mt: 1, display: "block" }}>
              Inventory: ${run.result.inventoryPath}
            </${Typography}>
          `}
        </div>
      `}
    </${Paper}>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Run History List
 * ═══════════════════════════════════════════════════════════════ */

function RunHistoryList({ onBack }) {
  useEffect(() => { loadRuns(); }, []);

  const runs = flowRuns.value || [];

  return html`
    <div>
      <${Button}
        variant="text"
        size="small"
        onClick=${onBack}
        sx=${{ mb: 2, textTransform: "none" }}
        startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
      >
        Back to Templates
      </${Button}>

      <${Typography} variant="h6" fontWeight=${700} sx=${{ mb: 2 }}>
        Run History
      </${Typography}>

      ${runs.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 4, textAlign: "center" }}>
          <${Typography} color="text.secondary">No runs yet. Execute a template to see results here.</${Typography}>
        </${Paper}>
      `}

      <${Stack} spacing=${1.5}>
        ${runs.map(
          (run) => html`<${RunResultCard} key=${run.id} run=${run} />`,
        )}
      </${Stack}>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Template List View (main view)
 * ═══════════════════════════════════════════════════════════════ */

function TemplateListView() {
  const tmpls = flowTemplates.value || [];

  // Group by category
  const groups = useMemo(() => {
    const map = {};
    tmpls.forEach((t) => {
      const cat = t.category || "custom";
      if (!map[cat]) map[cat] = [];
      map[cat].push(t);
    });
    const order = ["audit", "generate", "transform", "custom"];
    return order
      .filter((k) => map[k]?.length > 0)
      .map((k) => ({ key: k, meta: getCategoryMeta(k), items: map[k] }));
  }, [tmpls]);

  return html`
    <div>
      <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 3, maxWidth: "600px" }}>
        One-shot transformations for your codebase. Pick a template, fill the form, and trigger.
        Each flow runs once — annotate, generate skills, prepare configs, and more.
      </${Typography}>

      <!-- Template grid grouped by category -->
      ${groups.map(
        ({ key, meta, items }) => html`
          <div key=${key} style="margin-bottom: 24px;">
            <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5, pb: 0.5, borderBottom: "1px solid", borderColor: "divider" }}>
              <span class="icon-inline" style=${{ fontSize: "16px", color: meta.color }}>
                ${resolveIcon(meta.icon)}
              </span>
              <${Typography} variant="subtitle2" fontWeight=${600} color="text.secondary">
                ${meta.label}
              </${Typography}>
              <${Chip} label=${items.length} size="small" sx=${{ fontSize: "10px", height: "18px" }} />
            </${Stack}>

            <div style="display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));">
              ${items.map(
                (t) => html`
                  <${TemplateCard}
                    key=${t.id}
                    template=${t}
                    onClick=${() => {
                      selectedTemplate.value = t;
                      viewMode.value = "form";
                      activeRun.value = null;
                      haptic();
                    }}
                  />
                `,
              )}
            </div>
          </div>
        `,
      )}

      ${tmpls.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 4, textAlign: "center" }}>
          <${Typography} variant="h6" sx=${{ mb: 1 }}>No Templates Available</${Typography}>
          <${Typography} color="text.secondary">
            Templates will appear here once the manual flows system is initialized.
          </${Typography}>
        </${Paper}>
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Workflow Launcher — browse & run automatic workflow templates
 *  with custom parameters (auto-detected from template variables)
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Infer a human-readable label from a camelCase or snake_case variable key.
 */
function humanizeKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Infer concise helper text from a variable key.
 */
function inferHelpText(key, defaultValue) {
  const k = key.toLowerCase();
  if (k.includes("timeout") || k.includes("delay")) return `Duration in milliseconds (default: ${defaultValue})`;
  if (k.includes("max") && k.includes("iter")) return `Maximum number of iterations (default: ${defaultValue})`;
  if (k.includes("max") && k.includes("retr")) return `Maximum retry attempts (default: ${defaultValue})`;
  if (k.includes("branch")) return `Git branch name (default: ${defaultValue || "main"})`;
  if (k.includes("domain")) return `Knowledge domain or area (default: ${defaultValue || "general"})`;
  if (k.includes("problem")) return "Describe the problem, question, or objective";
  if (k.includes("prnumber") || k.includes("pr_number")) return "Pull request number";
  if (k.includes("taskid") || k.includes("task_id")) return "Task identifier (e.g. TASK-1)";
  if (typeof defaultValue === "boolean") return `Toggle on/off (default: ${defaultValue ? "on" : "off"})`;
  if (typeof defaultValue === "number") return `Numeric value (default: ${defaultValue})`;
  return defaultValue ? `Default: ${defaultValue}` : "";
}

function isMissingValue(raw, inputKind) {
  if (inputKind === "toggle") return false;
  if (raw == null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function isQuickKey(key) {
  const k = String(key || "").toLowerCase();
  return (
    k.includes("task") ||
    k.includes("prompt") ||
    k.includes("problem") ||
    k.includes("goal") ||
    k.includes("message") ||
    k.includes("query") ||
    k.includes("executor") ||
    k.includes("sdk") ||
    k.includes("model") ||
    k.includes("branch") ||
    k.includes("title")
  );
}

function isLongTextKey(key, defaultValue) {
  const k = String(key || "").toLowerCase();
  return (
    k.includes("problem") ||
    k.includes("prompt") ||
    k.includes("description") ||
    k.includes("instructions") ||
    k.includes("message") ||
    k.includes("body") ||
    (typeof defaultValue === "string" && defaultValue.length > 80)
  );
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return [];
  const normalized = [];
  for (const opt of options) {
    if (opt && typeof opt === "object" && "value" in opt) {
      normalized.push({ value: opt.value, label: String(opt.label ?? opt.value) });
      continue;
    }
    normalized.push({ value: opt, label: String(opt) });
  }
  const deduped = [];
  const seen = new Set();
  for (const opt of normalized) {
    const key = String(opt.value);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(opt);
  }
  return deduped;
}

function inferOptionsFromKey(key, defaultValue) {
  const k = String(key || "").toLowerCase();
  const values = [];
  if (k.includes("executor") || k.includes("sdk")) {
    values.push("auto", "codex", "claude", "copilot");
  } else if (k.includes("bumptype") || k.includes("bump_type")) {
    values.push("patch", "minor", "major");
  }
  if (typeof defaultValue === "string" && defaultValue.trim()) {
    values.unshift(defaultValue.trim());
  }
  return normalizeOptions(values);
}

function formatValuePreview(value) {
  if (value == null) return "empty";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "empty";
    return trimmed.length > 44 ? `${trimmed.slice(0, 44)}…` : trimmed;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > 44 ? `${json.slice(0, 44)}…` : json;
  } catch {
    return String(value);
  }
}

function buildVariableDescriptor(variable) {
  const key = String(variable?.key || "");
  const defaultValue = variable?.defaultValue;
  const type = variable?.type || (
    typeof defaultValue === "number"
      ? "number"
      : typeof defaultValue === "boolean"
      ? "toggle"
      : "text"
  );
  const required = variable?.required === true || defaultValue === "" || defaultValue == null;
  const backendOptions = normalizeOptions(variable?.options);
  const inferredOptions = inferOptionsFromKey(key, defaultValue);
  const options = backendOptions.length > 0 ? backendOptions : inferredOptions;
  let inputKind = variable?.input;
  if (!inputKind) {
    if (type === "toggle") inputKind = "toggle";
    else if (type === "number") inputKind = "number";
    else if (Array.isArray(defaultValue) || (defaultValue && typeof defaultValue === "object")) inputKind = "json";
    else if (options.length > 0) inputKind = "select";
    else if (isLongTextKey(key, defaultValue)) inputKind = "textarea";
    else inputKind = "text";
  }

  const defaultFieldValue =
    inputKind === "json" && defaultValue != null
      ? JSON.stringify(defaultValue, null, 2)
      : (defaultValue ?? "");

  return {
    ...variable,
    key,
    label: humanizeKey(key),
    required,
    type,
    inputKind,
    options,
    helpText: variable?.description || inferHelpText(key, defaultValue),
    defaultFieldValue,
    isQuick: required || isQuickKey(key),
  };
}

function getRunStatusBadgeStyles(status) {
  if (status === "completed") return { bg: "#10b98130", color: "#10b981" };
  if (status === "failed") return { bg: "#ef444430", color: "#ef4444" };
  if (status === "running") return { bg: "#3b82f630", color: "#60a5fa" };
  return { bg: "#6b728030", color: "#9ca3af" };
}

function getRunActivityAt(run) {
  const lastLogAt = Number(run?.lastLogAt);
  const lastProgressAt = Number(run?.lastProgressAt);
  const startedAt = Number(run?.startedAt);
  const candidates = [lastLogAt, lastProgressAt, startedAt].filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function getNodeStatusRank(status) {
  if (status === "running") return 0;
  if (status === "failed") return 1;
  if (status === "waiting") return 2;
  if (status === "pending") return 3;
  if (status === "completed") return 4;
  if (status === "skipped") return 5;
  return 6;
}

function buildNodeStatusesFromRunDetail(run) {
  const detail = run?.detail || {};
  const statuses = { ...(detail?.nodeStatuses || {}) };
  const statusEvents = Array.isArray(detail?.nodeStatusEvents) ? detail.nodeStatusEvents : [];
  const logs = Array.isArray(detail?.logs) ? detail.logs : [];

  for (const event of statusEvents) {
    const nodeId = String(event?.nodeId || "").trim();
    const status = String(event?.status || "").trim();
    if (!nodeId || !status) continue;
    statuses[nodeId] = status;
  }

  if (Object.keys(statuses).length === 0) {
    const fallbackStatus = run?.status === "failed"
      ? "failed"
      : run?.status === "completed"
        ? "completed"
        : "running";
    for (const entry of logs) {
      const nodeId = String(entry?.nodeId || "").trim();
      if (!nodeId || statuses[nodeId]) continue;
      statuses[nodeId] = fallbackStatus;
    }
  }

  return statuses;
}

function safePrettyJson(value) {
  try {
    const json = JSON.stringify(value, null, 2);
    const maxChars = 100000;
    if (json.length <= maxChars) return json;
    const omitted = json.length - maxChars;
    return `${json.slice(0, maxChars)}\n\n… [truncated ${omitted} chars]`;
  } catch {
    return String(value ?? "");
  }
}

async function resolveManualRunForDispatch(result) {
  const workflowId = String(result?.workflowId || "").trim();
  if (!workflowId) return null;
  const dispatchedAt = Date.parse(result?.dispatchedAt || "") || Date.now();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await loadManualWorkflowRuns(Math.max(MANUAL_WORKFLOW_RUN_PAGE_SIZE, 150));
      const candidates = (wfManualRuns.value || [])
        .filter((run) => String(run?.workflowId || "").trim() === workflowId)
        .filter((run) => {
          const startedAt = Number(run?.startedAt || 0);
          if (!Number.isFinite(startedAt) || startedAt <= 0) return true;
          return startedAt >= dispatchedAt - 5 * 60 * 1000;
        })
        .sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0));
      const match = candidates[0] || null;
      if (match?.runId) return match;
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return null;
}

/**
 * Workflow template card for the launcher grid.
 */
function WfTemplateCard({ template, onClick }) {
  const catMeta = WF_CATEGORY_META[template.category] || WF_CATEGORY_META.custom;
  const varCount = (template.variables || []).length;
  const hasBackEdges = (template.tags || []).some((t) => t === "back-edge" || t === "convergence");

  return html`
    <${Card}
      variant="outlined"
      sx=${{
        cursor: "pointer",
        transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
        position: "relative",
        overflow: "visible",
        "&:hover": {
          borderColor: catMeta.color,
          transform: "translateY(-2px)",
          boxShadow: "0 8px 25px rgba(0,0,0,0.25)",
        },
      }}
      onClick=${onClick}
    >
      <${CardContent} sx=${{ pb: "12px !important" }}>
        <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
          <${Box} sx=${{
            width: 32, height: 32, borderRadius: "8px",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: catMeta.bg, border: "1px solid " + catMeta.color + "30",
          }}>
            <span class="icon-inline" style=${{ fontSize: "16px", color: catMeta.color }}>
              ${resolveIcon(catMeta.icon)}
            </span>
          </${Box}>
          <${Typography} variant="subtitle2" fontWeight=${600} sx=${{ flex: 1, lineHeight: 1.3 }}>
            ${template.name}
          </${Typography}>
        </${Stack}>

        <${Typography} variant="body2" color="text.secondary" sx=${{
          mb: 1.5, lineHeight: 1.5, fontSize: "0.8rem",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>
          ${template.description}
        </${Typography}>

        <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" useFlexGap>
          <${Chip}
            label=${catMeta.label}
            size="small"
            sx=${{ fontSize: "10px", height: "20px", background: catMeta.bg, color: catMeta.color }}
            variant="outlined"
          />
          ${varCount > 0 && html`
            <${Chip}
              label=${`${varCount} param${varCount !== 1 ? "s" : ""}`}
              size="small"
              sx=${{ fontSize: "10px", height: "20px" }}
              variant="outlined"
            />
          `}
          <${Chip}
            label=${`${template.nodeCount} nodes`}
            size="small"
            sx=${{ fontSize: "10px", height: "20px" }}
            variant="outlined"
          />
          ${template.trigger === "trigger.manual" && html`
            <${Chip} label="Manual" size="small" color="primary"
              sx=${{ fontSize: "10px", height: "20px" }} variant="outlined" />
          `}
        </${Stack}>
      </${CardContent}>
    </${Card}>
  `;
}

/**
 * Workflow launch form — auto-renders fields from template variables.
 */
function WfLaunchForm({ template, onBack }) {
  const vars = template.variables || [];
  const descriptors = useMemo(() => vars.map(buildVariableDescriptor), [vars]);

  const [formValues, setFormValues] = useState(() => {
    const defaults = {};
    for (const desc of descriptors) {
      defaults[desc.key] = desc.defaultFieldValue;
    }
    return defaults;
  });
  const [launchMode, setLaunchMode] = useState(() => {
    const requiredCount = descriptors.filter((v) => v.required).length;
    return requiredCount > 0 ? "quick" : "advanced";
  });
  const [expanded, setExpanded] = useState(() => descriptors.length <= 5);

  const catMeta = WF_CATEGORY_META[template.category] || WF_CATEGORY_META.custom;

  const requiredVars = useMemo(
    () => descriptors.filter((v) => v.required),
    [descriptors],
  );
  const optionalVars = useMemo(
    () => descriptors.filter((v) => !v.required),
    [descriptors],
  );
  const quickOptionalVars = useMemo(
    () => optionalVars.filter((v) => v.isQuick).slice(0, 4),
    [optionalVars],
  );
  const quickVars = useMemo(
    () => [...requiredVars, ...quickOptionalVars.filter((v) => !requiredVars.some((r) => r.key === v.key))],
    [requiredVars, quickOptionalVars],
  );

  const handleChange = useCallback((key, value) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const validation = useMemo(() => {
    const missing = [];
    const invalid = [];

    for (const desc of descriptors) {
      const current = formValues[desc.key];
      if (desc.required && isMissingValue(current, desc.inputKind)) {
        missing.push(desc.label);
      }
      if (desc.inputKind === "json" && !isMissingValue(current, desc.inputKind)) {
        try {
          JSON.parse(String(current));
        } catch {
          invalid.push(desc.label);
        }
      }
    }
    return { missing, invalid };
  }, [descriptors, formValues]);

  const canLaunch = !wfLaunching.value && validation.missing.length === 0 && validation.invalid.length === 0;

  const effectiveOptional = useMemo(() => {
    return optionalVars.map((desc) => ({
      key: desc.key,
      label: desc.label,
      value: formValues[desc.key],
    }));
  }, [optionalVars, formValues]);

  const buildLaunchPayload = useCallback(() => {
    const payload = {};
    for (const desc of descriptors) {
      const current = formValues[desc.key];
      if (desc.inputKind === "json") {
        if (isMissingValue(current, desc.inputKind)) {
          payload[desc.key] = "";
        } else {
          payload[desc.key] = JSON.parse(String(current));
        }
        continue;
      }
      if (desc.inputKind === "number") {
        payload[desc.key] = current === "" || current == null ? "" : Number(current);
        continue;
      }
      if (desc.inputKind === "toggle") {
        payload[desc.key] = !!current;
        continue;
      }
      payload[desc.key] = current;
    }
    return payload;
  }, [descriptors, formValues]);

  const handleLaunch = useCallback(async () => {
    if (!canLaunch) return;
    haptic();
    const payload = buildLaunchPayload();
    const launchResult = await launchWorkflowTemplate(template.id, payload);
    if (launchResult?.accepted) {
      const matchedRun = await resolveManualRunForDispatch(launchResult);
      if (matchedRun?.runId) {
        wfLaunchResult.value = {
          ...wfLaunchResult.value,
          runId: matchedRun.runId,
          startedAt: matchedRun.startedAt,
        };
      }
    }
  }, [buildLaunchPayload, canLaunch, template.id]);

  const handleReset = useCallback(() => {
    const defaults = {};
    for (const desc of descriptors) {
      defaults[desc.key] = desc.defaultFieldValue;
    }
    setFormValues(defaults);
    setLaunchMode(requiredVars.length > 0 ? "quick" : "advanced");
  }, [descriptors, requiredVars.length]);

  const handleOpenRunHistory = useCallback(async (runId = null) => {
    activeTab.value = 1;
    viewMode.value = "wf-runs";
    await loadManualWorkflowRuns(Math.max(MANUAL_WORKFLOW_RUN_PAGE_SIZE, 150));
    const safeRunId = String(runId || "").trim();
    if (safeRunId) {
      await loadManualWorkflowRunDetail(safeRunId);
    } else {
      selectedWfRunId.value = null;
      selectedWfRunDetail.value = null;
    }
  }, []);

  return html`
    <div>
      <!-- Back button -->
      <${Button}
        variant="text" size="small"
        onClick=${() => { onBack(); wfLaunchResult.value = null; }}
        sx=${{ mb: 2, textTransform: "none" }}
        startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
      >
        Back to Workflows
      </${Button}>

      <!-- Header card -->
      <${Paper} variant="outlined" sx=${{
        p: 2.5, mb: 3,
        borderLeft: "4px solid " + catMeta.color,
        background: "linear-gradient(135deg, " + catMeta.bg + " 0%, transparent 100%)",
      }}>
        <${Stack} direction="row" alignItems="center" spacing=${1.5} sx=${{ mb: 1 }}>
          <${Box} sx=${{
            width: 40, height: 40, borderRadius: "10px",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: catMeta.color + "20",
          }}>
            <span class="icon-inline" style=${{ fontSize: "20px", color: catMeta.color }}>
              ${resolveIcon(catMeta.icon)}
            </span>
          </${Box}>
          <div style="flex: 1;">
            <${Typography} variant="h6" fontWeight=${700}>${template.name}</${Typography}>
            <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 0.5 }}>
              ${template.description}
            </${Typography}>
          </div>
        </${Stack}>

        <${Stack} direction="row" spacing=${1} sx=${{ mt: 1.5 }}>
          <${Chip} label=${catMeta.label} size="small" sx=${{ fontSize: "10px", background: catMeta.bg, color: catMeta.color }} />
          <${Chip} label=${`${template.nodeCount} nodes · ${template.edgeCount} edges`} size="small" variant="outlined" sx=${{ fontSize: "10px" }} />
          ${template.trigger && html`
            <${Chip} label=${template.trigger.replace("trigger.", "").replace(/_/g, " ")} size="small" variant="outlined" sx=${{ fontSize: "10px" }} />
          `}
        </${Stack}>
      </${Paper}>

      <!-- Parameters form -->
      <${Paper} variant="outlined" sx=${{ p: 2.5, mb: 3 }}>
        <${Stack} direction="row" alignItems="center" justifyContent="space-between" sx=${{ mb: 2 }}>
          <${Typography} variant="subtitle2" fontWeight=${600}>
            ${vars.length > 0
              ? "Launch Configuration"
              : "No Configurable Parameters"}
          </${Typography}>
          ${vars.length > 0 && html`
            <${Button} size="small" variant="text" onClick=${handleReset}
              sx=${{ textTransform: "none", fontSize: "0.75rem" }}
              startIcon=${html`<span class="icon-inline" style="font-size: 14px">${resolveIcon("refresh")}</span>`}
            >
              Reset Defaults
            </${Button}>
          `}
        </${Stack}>

        ${vars.length === 0 && html`
          <${Alert} severity="info" sx=${{ mb: 2 }}>
            This workflow has no configurable parameters. It will run with its default configuration.
          </${Alert}>
        `}

        ${vars.length > 0 && html`
          <${Tabs}
            value=${launchMode}
            onChange=${(_e, next) => setLaunchMode(next)}
            variant="fullWidth"
            sx=${{ mb: 2, minHeight: 38, "& .MuiTab-root": { minHeight: 38, textTransform: "none", fontSize: "0.8rem" } }}
          >
            <${Tab} value="quick" label=${`Quick (${quickVars.length})`} />
            <${Tab} value="advanced" label=${`Advanced (${descriptors.length})`} />
          </${Tabs}>
        `}

        ${validation.missing.length > 0 && html`
          <${Alert} severity="warning" sx=${{ mb: 2 }}>
            Missing required fields: ${validation.missing.join(", ")}
          </${Alert}>
        `}
        ${validation.invalid.length > 0 && html`
          <${Alert} severity="error" sx=${{ mb: 2 }}>
            Invalid JSON in: ${validation.invalid.join(", ")}
          </${Alert}>
        `}

        ${launchMode === "quick" && html`
          ${quickVars.map((v) => html`
            <${WfParamField}
              key=${v.key}
              descriptor=${v}
              value=${formValues[v.key]}
              onChange=${handleChange}
            />
          `)}

          ${optionalVars.length > 0 && html`
            <${Divider} sx=${{ my: 2 }}>
              <${Chip} size="small" variant="outlined" label=${`${optionalVars.length} optional default${optionalVars.length !== 1 ? "s" : ""}`} sx=${{ fontSize: "10px" }} />
            </${Divider}>
            <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mb: 1 }}>
              Advanced mode lets you override these values.
            </${Typography}>
            <${Box} sx=${{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
              ${effectiveOptional.map((entry) => html`
                <${Chip}
                  key=${entry.key}
                  size="small"
                  variant="outlined"
                  label=${`${entry.label}: ${formatValuePreview(entry.value)}`}
                  sx=${{ fontSize: "10px", maxWidth: "100%" }}
                />
              `)}
            </${Box}>
            <${Button}
              size="small"
              variant="text"
              onClick=${() => setLaunchMode("advanced")}
              sx=${{ textTransform: "none", mt: 1.5 }}
            >
              Switch to Advanced
            </${Button}>
          `}
        `}

        ${launchMode === "advanced" && html`
          ${requiredVars.length > 0 && html`
            <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mb: 1 }}>
              Required
            </${Typography}>
            ${requiredVars.map((v) => html`
              <${WfParamField}
                key=${v.key}
                descriptor=${v}
                value=${formValues[v.key]}
                onChange=${handleChange}
              />
            `)}
          `}

          ${optionalVars.length > 0 && requiredVars.length > 0 && html`
            <${Divider} sx=${{ my: 2 }}>
              <${Chip}
                label=${`${optionalVars.length} optional parameter${optionalVars.length !== 1 ? "s" : ""}`}
                size="small"
                variant="outlined"
                sx=${{ fontSize: "10px", cursor: "pointer" }}
                onClick=${() => setExpanded(!expanded)}
              />
            </${Divider}>
          `}

          ${(expanded || requiredVars.length === 0) && optionalVars.map((v) => html`
            <${WfParamField}
              key=${v.key}
              descriptor=${v}
              value=${formValues[v.key]}
              onChange=${handleChange}
            />
          `)}

          ${!expanded && optionalVars.length > 0 && requiredVars.length > 0 && html`
            <${Button}
              fullWidth
              size="small"
              variant="text"
              onClick=${() => setExpanded(true)}
              sx=${{ textTransform: "none", mt: 1, color: "text.secondary" }}
            >
              Show ${optionalVars.length} optional parameters...
            </${Button}>
          `}
        `}

        <${Divider} sx=${{ my: 2.5 }} />

        <${Stack} direction="row" spacing=${1.5} justifyContent="flex-end">
          <${Button} variant="outlined" size="small"
            onClick=${() => { onBack(); wfLaunchResult.value = null; }}
            sx=${{ textTransform: "none" }}>
            Cancel
          </${Button}>

          <${Button}
            variant="contained"
            onClick=${handleLaunch}
            disabled=${!canLaunch}
            startIcon=${wfLaunching.value
              ? html`<${CircularProgress} size=${16} color="inherit" />`
              : html`<span class="icon-inline">${resolveIcon("play")}</span>`}
            sx=${{
              textTransform: "none",
              background: catMeta.color,
              "&:hover": { background: catMeta.color, filter: "brightness(1.2)" },
            }}
          >
            ${wfLaunching.value ? "Launching…" : "Launch Workflow"}
          </${Button}>
        </${Stack}>
      </${Paper}>

      <!-- Launch result -->
      ${wfLaunchResult.value && html`
        <${Fade} in>
          <${Paper} variant="outlined" sx=${{
            p: 2.5,
            borderColor: wfLaunchResult.value.ok ? "#10b981" + "60" : "#ef4444" + "60",
            borderLeft: "4px solid " + (wfLaunchResult.value.ok ? "#10b981" : "#ef4444"),
          }}>
            ${wfLaunchResult.value.ok ? html`
              <${Alert} severity="success" sx=${{ mb: 1.5 }}>
                Workflow dispatched successfully
              </${Alert}>
              <${Stack} spacing=${0.5}>
                <${Typography} variant="body2"><strong>Template:</strong> ${wfLaunchResult.value.templateName}</${Typography}>
                <${Typography} variant="body2"><strong>Workflow ID:</strong> <code>${wfLaunchResult.value.workflowId}</code></${Typography}>
                <${Typography} variant="body2"><strong>Run ID:</strong> <code>${wfLaunchResult.value.runId || "resolving..."}</code></${Typography}>
                <${Typography} variant="body2"><strong>Mode:</strong> ${wfLaunchResult.value.mode}</${Typography}>
                ${wfLaunchResult.value.dispatchedAt && html`
                  <${Typography} variant="caption" color="text.secondary">
                    Dispatched at ${new Date(wfLaunchResult.value.dispatchedAt).toLocaleString()}
                  </${Typography}>
                `}
              </${Stack}>
              <${Stack} direction="row" spacing=${1} sx=${{ mt: 1.25 }}>
                <${Button}
                  variant="outlined"
                  size="small"
                  onClick=${() => handleOpenRunHistory(wfLaunchResult.value.runId)}
                  sx=${{ textTransform: "none" }}
                >
                  ${wfLaunchResult.value.runId ? "Open this run" : "Open manual run history"}
                </${Button}>
              </${Stack}>
              ${wfLaunchResult.value.variables && html`
                <${Divider} sx=${{ my: 1.5 }} />
                <${Typography} variant="caption" fontWeight=${600} sx=${{ mb: 0.5, display: "block" }}>
                  Effective Variables:
                </${Typography}>
                <${Box} sx=${{
                  p: 1.5, borderRadius: 1,
                  background: "rgba(0,0,0,0.2)",
                  fontFamily: "monospace", fontSize: "0.8em",
                  maxHeight: 200, overflow: "auto",
                }}>
                  ${Object.entries(wfLaunchResult.value.variables).map(([k, v]) => html`
                    <div key=${k}><span style="color: #10b981">${k}</span>: ${JSON.stringify(v)}</div>
                  `)}
                </${Box}>
              `}
            ` : html`
              <${Alert} severity="error">
                ${wfLaunchResult.value.error || "Unknown error"}
              </${Alert}>
            `}
          </${Paper}>
        </${Fade}>
      `}
    </div>
  `;
}

/**
 * Auto-generated parameter field from workflow template variable definition.
 */
function WfParamField({ descriptor, value, onChange }) {
  const {
    key,
    label,
    required,
    defaultValue,
    inputKind,
    options,
    helpText,
  } = descriptor;
  const currentValue = value !== undefined ? value : descriptor.defaultFieldValue;
  const [forceText, setForceText] = useState(() => {
    if (inputKind !== "select") return false;
    return !options.some((opt) => String(opt.value) === String(currentValue ?? ""));
  });

  if (inputKind === "toggle") {
    return html`
      <${Box} sx=${{ mb: 2 }}>
        <${FormControlLabel}
          control=${html`<${Switch}
            checked=${!!currentValue}
            onChange=${(e) => onChange(key, e.target.checked)}
            size="small"
          />`}
          label=${html`<span>${label}${required ? html` <span style="color: #ef4444">*</span>` : ""}</span>`}
        />
        ${helpText && html`<${Typography} variant="caption" display="block" color="text.secondary" sx=${{ ml: 4.5, mt: -0.5 }}>${helpText}</${Typography}>`}
      </${Box}>
    `;
  }

  if (inputKind === "number") {
    return html`
      <${TextField}
        fullWidth size="small" type="number"
        label=${label + (required ? " *" : "")}
        value=${currentValue}
        onChange=${(e) => onChange(key, e.target.value === "" ? "" : Number(e.target.value))}
        helperText=${helpText}
        sx=${{ mb: 2 }}
      />
    `;
  }

  if (inputKind === "json") {
    return html`
      <${TextField}
        fullWidth size="small" multiline rows=${4}
        label=${label + (required ? " *" : "")}
        value=${currentValue}
        onChange=${(e) => onChange(key, e.target.value)}
        helperText=${helpText || "JSON object or array"}
        placeholder=${defaultValue != null ? JSON.stringify(defaultValue, null, 2) : ""}
        sx=${{ mb: 2, "& .MuiInputBase-input": { fontFamily: "monospace", fontSize: "0.82rem" } }}
      />
    `;
  }

  if (inputKind === "select" && !forceText) {
    const selectedValue = currentValue ?? "";
    return html`
      <${FormControl} fullWidth size="small" sx=${{ mb: 2 }}>
        <${InputLabel}>${label + (required ? " *" : "")}</${InputLabel}>
        <${Select}
          label=${label + (required ? " *" : "")}
          value=${selectedValue}
          onChange=${(e) => onChange(key, e.target.value)}
        >
          ${options.map((opt) => html`
            <${MenuItem} key=${String(opt.value)} value=${opt.value}>${opt.label}</${MenuItem}>
          `)}
        </${Select}>
        ${(helpText || true) && html`
          <${Typography} variant="caption" color="text.secondary" sx=${{ mt: 0.5, ml: 1.5 }}>
            ${helpText || "Pick a preset value"} ·
            <button
              type="button"
              onClick=${() => setForceText(true)}
              style="margin-left:6px;background:none;border:none;color:#60a5fa;cursor:pointer;padding:0;font:inherit;"
            >
              enter custom value
            </button>
          </${Typography}>
        `}
      </${FormControl}>
    `;
  }

  // Default text/textarea input.
  const isLongText = inputKind === "textarea" || isLongTextKey(key, defaultValue);

  return html`
    <${TextField}
      fullWidth size="small"
      label=${label + (required ? " *" : "")}
      value=${currentValue}
      onChange=${(e) => onChange(key, e.target.value)}
      helperText=${helpText}
      multiline=${isLongText}
      rows=${isLongText ? 3 : undefined}
      placeholder=${defaultValue ? String(defaultValue) : ""}
      sx=${{ mb: 2, ...(isLongText ? { "& .MuiInputBase-input": { fontFamily: "monospace", fontSize: "0.85em" } } : {}) }}
    />
  `;
}

/**
 * Workflow Launcher list view — browse all automatic workflow templates,
 * filter by category/search, and select one to configure + launch.
 */
function WfLauncherView() {
  const templates = wfTemplates.value || [];
  const search = wfSearchQuery.value.toLowerCase();
  const catFilter = wfSelectedCategory.value;

  // Available categories (from loaded templates)
  const categories = useMemo(() => {
    const cats = new Map();
    templates.forEach((t) => {
      const key = t.category || "custom";
      if (!cats.has(key)) cats.set(key, 0);
      cats.set(key, cats.get(key) + 1);
    });
    const ordered = [
      "github", "agents", "planning", "cicd",
      "reliability", "security", "lifecycle", "research", "custom",
    ];
    return ordered
      .filter((k) => cats.has(k))
      .map((k) => ({ key: k, count: cats.get(k), meta: WF_CATEGORY_META[k] || WF_CATEGORY_META.custom }));
  }, [templates]);

  // Filter templates
  const filtered = useMemo(() => {
    return templates.filter((t) => {
      if (catFilter !== "all" && t.category !== catFilter) return false;
      if (search) {
        const hay = (t.name + " " + t.description + " " + (t.tags || []).join(" ")).toLowerCase();
        return hay.includes(search);
      }
      return true;
    });
  }, [templates, search, catFilter]);

  // Group filtered by category
  const groups = useMemo(() => {
    const map = {};
    filtered.forEach((t) => {
      const cat = t.category || "custom";
      if (!map[cat]) map[cat] = [];
      map[cat].push(t);
    });
    const order = [
      "github", "agents", "planning", "cicd",
      "reliability", "security", "lifecycle", "research", "custom",
    ];
    return order
      .filter((k) => map[k]?.length > 0)
      .map((k) => ({ key: k, meta: WF_CATEGORY_META[k] || WF_CATEGORY_META.custom, items: map[k] }));
  }, [filtered]);

  return html`
    <div>
      <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 2.5, maxWidth: "700px" }}>
        Launch any automatic workflow with custom parameters.
        Select a workflow, configure its variables, and trigger a run — no need to edit the workflow definition.
      </${Typography}>

      <!-- Search + category filter bar -->
      <${Stack} direction="row" spacing=${1.5} alignItems="center" sx=${{ mb: 3 }}>
        <${TextField}
          size="small"
          placeholder="Search workflows..."
          value=${wfSearchQuery.value}
          onChange=${(e) => { wfSearchQuery.value = e.target.value; }}
          sx=${{ flex: 1, maxWidth: 340 }}
          InputProps=${{ startAdornment: html`<span class="icon-inline" style="margin-right: 8px; opacity: 0.5; font-size: 14px">${resolveIcon("search")}</span>` }}
        />
        <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: "wrap" }}>
          <${Chip}
            label="All"
            size="small"
            variant=${catFilter === "all" ? "filled" : "outlined"}
            onClick=${() => { wfSelectedCategory.value = "all"; }}
            sx=${{ fontSize: "11px", cursor: "pointer" }}
          />
          ${categories.map(({ key, count, meta }) => html`
            <${Chip}
              key=${key}
              label=${`${meta.label} (${count})`}
              size="small"
              variant=${catFilter === key ? "filled" : "outlined"}
              onClick=${() => { wfSelectedCategory.value = key; }}
              sx=${{
                fontSize: "11px", cursor: "pointer",
                ...(catFilter === key ? { background: meta.color + "30", color: meta.color } : {}),
              }}
            />
          `)}
        </${Stack}>
      </${Stack}>

      <!-- Template grid -->
      ${groups.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 4, textAlign: "center" }}>
          <${Typography} color="text.secondary">
            ${search || catFilter !== "all"
              ? "No workflows match your filter."
              : "No workflow templates available."}
          </${Typography}>
        </${Paper}>
      `}

      ${groups.map(({ key, meta, items }) => html`
        <div key=${key} style="margin-bottom: 20px;">
          <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5, pb: 0.5, borderBottom: "1px solid", borderColor: "divider" }}>
            <${Box} sx=${{
              width: 24, height: 24, borderRadius: "6px",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: meta.bg,
            }}>
              <span class="icon-inline" style=${{ fontSize: "12px", color: meta.color }}>
                ${resolveIcon(meta.icon)}
              </span>
            </${Box}>
            <${Typography} variant="subtitle2" fontWeight=${600} color="text.secondary">
              ${meta.label}
            </${Typography}>
            <${Chip} label=${items.length} size="small" sx=${{ fontSize: "10px", height: "18px" }} />
          </${Stack}>

          <div style="display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));">
            ${items.map((t) => html`
              <${WfTemplateCard}
                key=${t.id}
                template=${t}
                onClick=${() => {
                  selectedWfTemplate.value = t;
                  viewMode.value = "wf-form";
                  wfLaunchResult.value = null;
                  haptic();
                }}
              />
            `)}
          </div>
        </div>
      `)}
    </div>
  `;
}

function ManualWorkflowRunHistoryView({ onBack }) {
  const runs = wfManualRuns.value || [];
  const selectedRun = selectedWfRunDetail.value;
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    loadManualWorkflowRuns(Math.max(MANUAL_WORKFLOW_RUN_PAGE_SIZE, 150)).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const hasRunning = runs.some((run) => run?.status === "running");
    const pollMs = hasRunning ? 3000 : 15000;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      await loadManualWorkflowRuns(Math.max(MANUAL_WORKFLOW_RUN_PAGE_SIZE, 150)).catch(() => {});
      if (!cancelled && selectedWfRunId.value && selectedWfRunDetail.value?.status === "running") {
        await loadManualWorkflowRunDetail(selectedWfRunId.value).catch(() => {});
      }
    };

    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runs, selectedWfRunId.value, selectedWfRunDetail.value?.status]);

  const filteredRuns = useMemo(() => {
    const query = String(searchQuery || "").trim().toLowerCase();
    return runs.filter((run) => {
      const runStatus = String(run?.status || "unknown").toLowerCase();
      const workflowName = String(run?.workflowName || run?.workflowId || "").toLowerCase();
      const runId = String(run?.runId || "").toLowerCase();
      if (statusFilter !== "all" && runStatus !== statusFilter) return false;
      if (!query) return true;
      return workflowName.includes(query) || runId.includes(query);
    });
  }, [runs, searchQuery, statusFilter]);

  if (selectedRun) {
    const logs = Array.isArray(selectedRun?.detail?.logs) ? selectedRun.detail.logs : [];
    const errors = Array.isArray(selectedRun?.detail?.errors) ? selectedRun.detail.errors : [];
    const nodeStatuses = buildNodeStatusesFromRunDetail(selectedRun);
    const nodeOutputs = selectedRun?.detail?.nodeOutputs || {};
    const nodeIds = Object.keys(nodeStatuses).sort((a, b) => {
      const rankDiff = getNodeStatusRank(nodeStatuses[a]) - getNodeStatusRank(nodeStatuses[b]);
      if (rankDiff !== 0) return rankDiff;
      return String(a).localeCompare(String(b));
    });
    const statusStyles = getRunStatusBadgeStyles(selectedRun.status);
    const finishedAt = selectedRun.status === "running" ? null : selectedRun.endedAt;
    const liveDuration = selectedRun.status === "running" && selectedRun.startedAt
      ? Math.max(0, nowTick - selectedRun.startedAt)
      : selectedRun.duration;
    const lastActivityAt = getRunActivityAt(selectedRun);
    const staleMs = selectedRun.status === "running" && lastActivityAt
      ? Math.max(0, nowTick - lastActivityAt)
      : 0;

    return html`
      <div>
        <${Button}
          variant="text"
          size="small"
          onClick=${() => {
            selectedWfRunId.value = null;
            selectedWfRunDetail.value = null;
          }}
          sx=${{ mb: 2, textTransform: "none" }}
          startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
        >
          Back to Manual Run History
        </${Button}>

        <${Paper} variant="outlined" sx=${{ p: 2.25, borderLeft: `4px solid ${statusStyles.color}` }}>
          <${Stack} direction="row" spacing=${1} alignItems="center" sx=${{ mb: 1 }}>
            <${Typography} variant="subtitle1" fontWeight=${700}>
              ${selectedRun.workflowName || selectedRun.workflowId || "Workflow Run"}
            </${Typography}>
            <${Chip} label=${selectedRun.status || "unknown"} size="small" sx=${{ background: statusStyles.bg, color: statusStyles.color }} />
          </${Stack}>
          <${Stack} spacing=${0.4} sx=${{ fontSize: "0.86rem" }}>
            <${Typography} variant="body2"><strong>Workflow ID:</strong> <code>${selectedRun.workflowId || "—"}</code></${Typography}>
            <${Typography} variant="body2"><strong>Run ID:</strong> <code>${selectedRun.runId || "—"}</code></${Typography}>
            <${Typography} variant="body2"><strong>Started:</strong> ${formatDate(selectedRun.startedAt)} (${formatRelative(selectedRun.startedAt)})</${Typography}>
            <${Typography} variant="body2"><strong>Finished:</strong> ${finishedAt ? formatDate(finishedAt) : "Running"}</${Typography}>
            <${Typography} variant="body2"><strong>Duration:</strong> ${formatDuration(liveDuration)}</${Typography}>
            <${Typography} variant="body2"><strong>Last Activity:</strong> ${lastActivityAt ? `${formatDate(lastActivityAt)} (${formatRelative(lastActivityAt)})` : "—"}</${Typography}>
            ${selectedRun.status === "running" && html`<${Typography} variant="body2"><strong>No Progress For:</strong> ${formatDuration(staleMs)}</${Typography}>`}
            <${Typography} variant="body2"><strong>Nodes:</strong> ${selectedRun.nodeCount || 0} · <strong>Logs:</strong> ${selectedRun.logCount || logs.length} · <strong>Errors:</strong> ${selectedRun.errorCount || errors.length}</${Typography}>
            <${Typography} variant="body2"><strong>Active Nodes:</strong> ${selectedRun.activeNodeCount || 0}</${Typography}>
          </${Stack}>
        </${Paper}>

        <${Paper} variant="outlined" sx=${{ p: 2, mt: 1.5 }}>
          <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Node Execution</${Typography}>
          ${nodeIds.length === 0 && html`<${Typography} variant="caption" color="text.secondary">No node execution data recorded.</${Typography}>`}
          <${Stack} spacing=${0.75}>
            ${nodeIds.map((nodeId) => {
              const nodeStatus = nodeStatuses[nodeId];
              const nodeStatusStyles = getRunStatusBadgeStyles(nodeStatus);
              return html`
                <${Stack} key=${nodeId} direction="row" spacing=${1} alignItems="center">
                  <code style="font-size:12px;">${nodeId}</code>
                  <${Chip} label=${nodeStatus || "unknown"} size="small" sx=${{ height: 20, fontSize: "10px", background: nodeStatusStyles.bg, color: nodeStatusStyles.color }} />
                </${Stack}>
              `;
            })}
          </${Stack}>
        </${Paper}>

        <${Paper} variant="outlined" sx=${{ p: 2, mt: 1.5 }}>
          <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Run Logs (${logs.length})</${Typography}>
          <pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:#c9d1d9;background:#111827;border-radius:6px;padding:8px;max-height:320px;overflow:auto;">${safePrettyJson(logs)}</pre>
        </${Paper}>

        <${Paper} variant="outlined" sx=${{ p: 2, mt: 1.5 }}>
          <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Errors (${errors.length})</${Typography}>
          <pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:#fca5a5;background:#111827;border-radius:6px;padding:8px;max-height:220px;overflow:auto;">${safePrettyJson(errors)}</pre>
        </${Paper}>

        <${Paper} variant="outlined" sx=${{ p: 2, mt: 1.5 }}>
          <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Node Outputs</${Typography}>
          <pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:#c9d1d9;background:#111827;border-radius:6px;padding:8px;max-height:280px;overflow:auto;">${safePrettyJson(nodeOutputs)}</pre>
        </${Paper}>
      </div>
    `;
  }

  return html`
    <div>
      <${Button}
        variant="text"
        size="small"
        onClick=${onBack}
        sx=${{ mb: 2, textTransform: "none" }}
        startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
      >
        Back to Workflows
      </${Button}>

      <${Typography} variant="h6" fontWeight=${700} sx=${{ mb: 2 }}>
        Manual Workflow Run History
      </${Typography}>

      <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1.5 }}>
        Shows manually launched workflow runs only. Automated monitor/scheduled runs are excluded.
      </${Typography}>

      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5, flexWrap: "wrap" }}>
        <${TextField}
          size="small"
          value=${searchQuery}
          onInput=${(e) => setSearchQuery(e.target.value)}
          placeholder="Search run ID or workflow..."
          sx=${{ minWidth: 220 }}
        />
        <${Select} size="small" value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)}>
          <${MenuItem} value="all">All statuses</${MenuItem}>
          <${MenuItem} value="running">Running</${MenuItem}>
          <${MenuItem} value="failed">Failed</${MenuItem}>
          <${MenuItem} value="completed">Completed</${MenuItem}>
        </${Select}>
        <${Button} variant="outlined" size="small" onClick=${() => loadManualWorkflowRuns(Math.max(MANUAL_WORKFLOW_RUN_PAGE_SIZE, 150))} sx=${{ textTransform: "none" }}>
          Refresh
        </${Button}>
      </${Stack}>

      ${wfManualRunsLoading.value && filteredRuns.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 2 }}>
          <${Typography} variant="body2" color="text.secondary">Loading manual workflow runs...</${Typography}>
        </${Paper}>
      `}

      ${!wfManualRunsLoading.value && filteredRuns.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 2.5, textAlign: "center" }}>
          <${Typography} variant="body2" color="text.secondary">No manual workflow runs found.</${Typography}>
        </${Paper}>
      `}

      <${Stack} spacing=${1}>
        ${filteredRuns.map((run) => {
          const styles = getRunStatusBadgeStyles(run.status);
          const activityAt = getRunActivityAt(run);
          const liveDuration = run.status === "running" && run.startedAt
            ? Math.max(0, nowTick - run.startedAt)
            : run.duration;
          return html`
            <${Button}
              key=${run.runId}
              variant="text"
              onClick=${() => loadManualWorkflowRunDetail(run.runId)}
              sx=${{
                textTransform: "none",
                justifyContent: "flex-start",
                p: 1.25,
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1.5,
                background: "background.paper",
              }}
            >
              <${Box} sx=${{ textAlign: "left", width: "100%" }}>
                <${Stack} direction="row" spacing=${1} alignItems="center" sx=${{ mb: 0.3 }}>
                  <${Typography} variant="body2" fontWeight=${600} sx=${{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ${run.workflowName || run.workflowId || "Workflow"}
                  </${Typography}>
                  <${Chip} label=${run.status || "unknown"} size="small" sx=${{ background: styles.bg, color: styles.color, height: 20, fontSize: "10px" }} />
                </${Stack}>
                <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                  Workflow: ${run.workflowId || "—"}
                </${Typography}>
                <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                  Run: ${run.runId || "—"}
                </${Typography}>
                <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                  Started ${formatDate(run.startedAt)} (${formatRelative(run.startedAt)}) · Duration ${formatDuration(liveDuration)}
                </${Typography}>
                <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                  Last activity ${activityAt ? formatRelative(activityAt) : "—"} · Nodes ${run.nodeCount || 0} · Logs ${run.logCount || 0} · Errors ${run.errorCount || 0}
                </${Typography}>
              </${Box}>
            </${Button}>
          `;
        })}
      </${Stack}>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Main Tab Export
 * ═══════════════════════════════════════════════════════════════ */

export function ManualFlowsTab() {
  useEffect(() => {
    loadTemplates();
    loadRuns();
    loadWfTemplates();
  }, []);

  useEffect(() => {
    const onWorkspaceSwitched = () => {
      selectedTemplate.value = null;
      selectedWfTemplate.value = null;
      activeRun.value = null;
      wfLaunchResult.value = null;
      viewMode.value = "templates";
      activeTab.value = 0;
      loadTemplates();
      loadRuns();
      loadWfTemplates();
    };
    window.addEventListener("ve:workspace-switched", onWorkspaceSwitched);
    return () => window.removeEventListener("ve:workspace-switched", onWorkspaceSwitched);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key !== "Escape") return;
      const activeTag = document.activeElement?.tagName || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(activeTag)) return;

      if (viewMode.value === "wf-form") {
        e.preventDefault();
        viewMode.value = "wf-launcher";
        selectedWfTemplate.value = null;
        wfLaunchResult.value = null;
      } else if (viewMode.value !== "templates" && viewMode.value !== "wf-launcher") {
        e.preventDefault();
        viewMode.value = activeTab.value === 0 ? "templates" : "wf-launcher";
        selectedTemplate.value = null;
        activeRun.value = null;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const mode = viewMode.value;
  const tab = activeTab.value;

  const handleTabChange = useCallback((_e, newTab) => {
    activeTab.value = newTab;
    viewMode.value = newTab === 0 ? "templates" : "wf-launcher";
    selectedTemplate.value = null;
    selectedWfTemplate.value = null;
    activeRun.value = null;
    wfLaunchResult.value = null;
    selectedWfRunId.value = null;
    selectedWfRunDetail.value = null;
    haptic();
  }, []);

  // ── Render based on current view mode ──
  const renderContent = () => {
    // Manual flow form
    if (mode === "form" && selectedTemplate.value) {
      return html`<${FlowFormView}
        template=${selectedTemplate.value}
        onBack=${() => {
          viewMode.value = "templates";
          selectedTemplate.value = null;
        }}
      />`;
    }
    // Run history
    if (mode === "runs") {
      return html`<${RunHistoryList}
        onBack=${() => { viewMode.value = "templates"; }}
      />`;
    }
    // Workflow launch form
    if (mode === "wf-form" && selectedWfTemplate.value) {
      return html`<${WfLaunchForm}
        template=${selectedWfTemplate.value}
        onBack=${() => {
          viewMode.value = "wf-launcher";
          selectedWfTemplate.value = null;
        }}
      />`;
    }
    // Manual workflow run history
    if (mode === "wf-runs") {
      return html`<${ManualWorkflowRunHistoryView}
        onBack=${() => {
          viewMode.value = "wf-launcher";
          selectedWfRunId.value = null;
          selectedWfRunDetail.value = null;
        }}
      />`;
    }
    // Workflow launcher grid
    if (mode === "wf-launcher" || tab === 1) {
      return html`<${WfLauncherView} />`;
    }
    // Default: manual flow templates
    return html`<${TemplateListView} />`;
  };

  return html`
    <div style="padding: 12px; max-width: 1200px; margin: 0 auto;">
      <!-- Tab switcher: Manual Flows vs Workflow Launcher -->
      ${mode !== "form" && mode !== "runs" && mode !== "wf-form" && mode !== "wf-runs" && html`
        <${Paper} elevation=${0} sx=${{ mb: 2, p: 1.25, border: "1px solid", borderColor: "divider", borderRadius: 2, backgroundColor: "background.paper" }}>
          <${Stack} direction="row" alignItems="center" spacing=${1.5}>
            <${Typography} variant="subtitle1" fontWeight=${700} sx=${{ flexShrink: 0 }}>
              ${tab === 0 ? "Manual Flows" : "Workflow Launcher"}
            </${Typography}>

            <${Tabs}
              value=${tab}
              onChange=${handleTabChange}
              sx=${{
                minHeight: 34,
                "& .MuiTab-root": {
                  minHeight: 34,
                  px: 1.25,
                  py: 0,
                  textTransform: "none",
                  fontSize: "0.8rem",
                  color: "text.secondary",
                },
                "& .MuiTab-root.Mui-selected": { color: "text.primary", fontWeight: 600 },
                "& .MuiTabs-indicator": { height: 2.5, borderRadius: 2, backgroundColor: "var(--accent)" },
              }}
            >
              <${Tab}
                label="Manual Flows"
                icon=${html`<span class="icon-inline" style="font-size: 14px; margin-right: 2px">${resolveIcon("play")}</span>`}
                iconPosition="start"
              />
              <${Tab}
                label=${html`
                  <${Stack} direction="row" alignItems="center" spacing=${0.5}>
                    <span>Workflow Launcher</span>
                    <${Chip}
                      label=${(wfTemplates.value || []).length}
                      size="small"
                      color="default"
                      sx=${{
                        fontSize: "10px",
                        height: "18px",
                        minWidth: "24px",
                        borderRadius: 999,
                        backgroundColor: "rgba(218,119,86,0.18)",
                      }}
                    />
                  </${Stack}>
                `}
                icon=${html`<span class="icon-inline" style="font-size: 14px; margin-right: 2px">${resolveIcon("rocket")}</span>`}
                iconPosition="start"
              />
            </${Tabs}>

            <div style="flex: 1;" />

            ${tab === 0 && html`
              <${Button}
                variant="outlined"
                size="small"
                onClick=${() => { viewMode.value = "runs"; haptic(); }}
                startIcon=${html`<span class="icon-inline">${resolveIcon("chart")}</span>`}
                sx=${{ textTransform: "none", borderRadius: 999 }}
              >
                Run History
              </${Button}>
            `}

            ${tab === 1 && html`
              <${Button}
                variant="outlined"
                size="small"
                onClick=${() => {
                  viewMode.value = "wf-runs";
                  selectedWfRunId.value = null;
                  selectedWfRunDetail.value = null;
                  loadManualWorkflowRuns(Math.max(MANUAL_WORKFLOW_RUN_PAGE_SIZE, 150)).catch(() => {});
                  haptic();
                }}
                startIcon=${html`<span class="icon-inline">${resolveIcon("chart")}</span>`}
                sx=${{ textTransform: "none", borderRadius: 999 }}
              >
                Manual Run History
              </${Button}>
            `}
          </${Stack}>
        </${Paper}>
      `}

      ${renderContent()}
    </div>
  `;
}
