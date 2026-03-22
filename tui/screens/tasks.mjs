import React from "react";
import htm from "htm";
import { Box, Text } from "ink";

const html = htm.bind(React.createElement);

const COLUMNS = ["todo", "inprogress", "inreview", "blocked", "done"];

function formatTask(task) {
  const id = String(task?.id || "").slice(0, 8) || "--------";
  const title = String(task?.title || "Untitled");
  return `${id}  ${title}`;
}

export default function TasksScreen({ tasks }) {
  const buckets = new Map(COLUMNS.map((column) => [column, []]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = String(task?.status || "todo").toLowerCase();
    if (!buckets.has(status)) buckets.set(status, []);
    buckets.get(status).push(task);
  }

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Text} dimColor>Task board view is read-only in the terminal build.<//>
      <${Box} marginTop=${1}>
        ${COLUMNS.map((column) => html`
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
