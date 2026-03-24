import React, { useCallback, useMemo, useState } from "react";
import htm from "htm";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import {
  TASK_COLUMNS,
  TASK_FORM_FIELDS,
  TASK_PRIORITY_OPTIONS,
  buildTaskFormRows,
  bucketTasksByStatus,
  createEmptyTaskFormState,
  formatTask,
  normalizeTaskCreatePayload,
} from "./tasks-screen-helpers.mjs";

const html = htm.bind(React.createElement);
const FIELD_ORDER = TASK_FORM_FIELDS;

function nextFieldIndex(index, delta) {
  return (index + delta + FIELD_ORDER.length) % FIELD_ORDER.length;
}

export default function TasksScreen({ tasks, wsBridge, isActive, onTaskCreated }) {
  const buckets = useMemo(() => bucketTasksByStatus(tasks), [tasks]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formState, setFormState] = useState(() => createEmptyTaskFormState());
  const [activeFieldIndex, setActiveFieldIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState("");

  const activeField = FIELD_ORDER[activeFieldIndex];
  const formRows = useMemo(
    () => buildTaskFormRows(formState, activeField),
    [activeField, formState],
  );

  const closeForm = useCallback(() => {
    setShowCreateForm(false);
    setSubmitting(false);
    setSubmitError("");
    setFormState(createEmptyTaskFormState());
    setActiveFieldIndex(0);
  }, []);

  const openForm = useCallback(() => {
    setShowCreateForm(true);
    setSubmitError("");
    setSubmitSuccess("");
    setFormState(createEmptyTaskFormState());
    setActiveFieldIndex(0);
  }, []);

  const updateActiveField = useCallback((value) => {
    setFormState((prev) => ({
      ...prev,
      [FIELD_ORDER[activeFieldIndex]]: value,
    }));
  }, [activeFieldIndex]);

  const submitTask = useCallback(async () => {
    const normalized = normalizeTaskCreatePayload(formState);
    if (!normalized.ok) {
      setSubmitError(normalized.error);
      return;
    }
    if (!wsBridge || typeof wsBridge.createTask !== "function") {
      setSubmitError("Task creation is unavailable until the UI bridge connects.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      const created = await wsBridge.createTask(normalized.payload);
      if (created && typeof onTaskCreated === "function") {
        onTaskCreated(created);
      }
      setSubmitSuccess(`Created task: ${normalized.payload.title}`);
      setShowCreateForm(false);
      setFormState(createEmptyTaskFormState());
      setActiveFieldIndex(0);
    } catch (error) {
      setSubmitError(String(error?.message || error || "Failed to create task."));
    } finally {
      setSubmitting(false);
    }
  }, [formState, onTaskCreated, wsBridge]);

  useInput((input, key) => {
    if (!isActive) return;

    if (!showCreateForm) {
      if (input === "c") {
        openForm();
      }
      return;
    }

    if (key.escape) {
      closeForm();
      return;
    }
    if (key.tab) {
      setActiveFieldIndex((prev) => nextFieldIndex(prev, key.shift ? -1 : 1));
      return;
    }
    if (key.upArrow) {
      setActiveFieldIndex((prev) => nextFieldIndex(prev, -1));
      return;
    }
    if (key.downArrow) {
      setActiveFieldIndex((prev) => nextFieldIndex(prev, 1));
      return;
    }
    if (activeField === "priority" && (key.leftArrow || key.rightArrow)) {
      const current = TASK_PRIORITY_OPTIONS.indexOf(String(formState.priority || "medium").toLowerCase());
      const next = current >= 0 ? current + (key.rightArrow ? 1 : -1) : 0;
      const normalized = TASK_PRIORITY_OPTIONS[(next + TASK_PRIORITY_OPTIONS.length) % TASK_PRIORITY_OPTIONS.length];
      setFormState((prev) => ({ ...prev, priority: normalized }));
    }
  }, { isActive });

  const handleInputSubmit = useCallback(() => {
    if (activeFieldIndex < FIELD_ORDER.length - 1) {
      setActiveFieldIndex((prev) => prev + 1);
      return;
    }
    void submitTask();
  }, [activeFieldIndex, submitTask]);

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Text} dimColor>
        Press c to create a task inline. Tab moves fields, Enter advances or submits, Esc cancels.
      <//>
      ${submitSuccess
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="green">${submitSuccess}<//>
            <//>
          `
        : null}
      ${showCreateForm
        ? html`
            <${Box} flexDirection="column" borderStyle="round" paddingX=${1} paddingY=${1} marginTop=${1}>
              <${Text} bold>Create task<//>
              ${formRows.map((row) => html`
                <${Box} key=${row.field} marginTop=${1}>
                  <${Text} color=${row.isActive ? "cyan" : undefined} bold=${row.isActive}>${row.label}: <//>
                  ${row.isActive
                    ? html`
                        <${TextInput}
                          value=${row.value}
                          onChange=${updateActiveField}
                          onSubmit=${handleInputSubmit}
                          placeholder=${row.inputPlaceholder}
                        />
                      `
                    : html`<${Text} dimColor=${row.isPlaceholder}>${row.displayValue}<//>`}
                <//>
              `)}
              <${Text} dimColor>Enter moves to the next field and submits from priority.<//>
              ${activeField === "priority"
                ? html`<${Text} dimColor>Use left/right arrows to cycle priority quickly.<//>`
                : null}
              ${submitError
                ? html`
                    <${Box} marginTop=${1}>
                      <${Text} color="red">${submitError}<//>
                    <//>
                  `
                : null}
              ${submitting
                ? html`
                    <${Box} marginTop=${1}>
                      <${Text} color="yellow">Creating task...<//>
                    <//>
                  `
                : null}
            <//>
          `
        : null}
      <${Box} marginTop=${1}>
        ${TASK_COLUMNS.map((column) => html`
          <${Box}
            key=${column}
            flexDirection="column"
            borderStyle="single"
            paddingX=${1}
            marginRight=${1}
            width=${24}
          >
            <${Text} bold>${column} (${(buckets.get(column) || []).length})<//>
            ${(buckets.get(column) || []).slice(0, 8).map((task) => html`
              <${Text} key=${task.id} wrap="truncate-end">${formatTask(task)}<//>
            `)}
            ${(buckets.get(column) || []).length === 0 && html`
              <${Text} dimColor>No tasks<//>
            `}
          <//>
        `)}
      <//>
    <//>
  `;
}