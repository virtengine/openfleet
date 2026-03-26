import React from "react";
import htm from "htm";
import { Box, Text } from "ink";

const html = htm.bind(React.createElement);

export const SHORTCUT_GROUPS = [
  {
    title: "Global",
    items: [
      ["1 / 2 / 3", "Switch primary screens"],
      ["A / T / L / W / X / S", "Jump to a screen by shortcut"],
      ["Tab / Shift+Tab", "Cycle screens"],
      ["?", "Toggle keyboard help overlay"],
      ["Q", "Quit the TUI"],
    ],
  },
  {
    title: "Agents screen",
    items: [
      ["↑ / ↓", "Move session selection"],
      ["Enter", "Open session detail"],
      ["L", "Open session logs"],
      ["D", "Open session diff"],
      ["K", "Queue session termination"],
      ["B", "Inspect backoff queue"],
      ["Esc", "Close detail panes / cancel kill"],
    ],
  },
  {
    title: "Tasks screen",
    items: [
      ["↑ / ↓ / ← / →", "Move task selection"],
      ["N", "Create task"],
      ["E / Enter", "Edit selected task"],
      ["D", "Delete selected task"],
      ["F", "Open filter"],
      ["V", "Toggle kanban/list view"],
      ["[ / ]", "Move task between statuses"],
    ],
  },
  {
    title: "Logs screen",
    items: [
      ["L", "Open session logs"],
      ["Esc", "Close logs"],
    ],
  },
  {
    title: "Telemetry screen",
    items: [
      ["1", "Open status metrics"],
      ["B", "Inspect retry/backoff queue"],
    ],
  },
  {
    title: "Workflows screen",
    items: [
      ["1", "Open workflow snapshot"],
      ["2", "Open tasks"],
    ],
  },
  {
    title: "Settings screen",
    items: [
      ["1 / 2 / 3", "Switch top-level views"],
      ["Q", "Quit"],
    ],
  },
  {
    title: "Modals",
    items: [
      ["Esc", "Dismiss current modal"],
      ["?", "Close help overlay"],
      ["Ctrl+S", "Save active form"],
      ["Tab / Shift+Tab", "Move between form fields"],
      ["← / →", "Change select field value"],
      ["Y / N", "Confirm or cancel destructive prompts"],
    ],
  },
];

export function getFooterHints(screen, context = {}) {
  if (context.helpOpen) {
    return [
      ["?", "Close help"],
      ["Esc", "Dismiss overlay"],
      ["↑/↓", "Scroll list"],
    ];
  }

  if (screen === "tasks") {
    if (context.deletePrompt) {
      return [["Y", "Confirm delete"], ["N", "Keep task"], ["Esc", "Cancel"], ["?", "Help"]];
    }
    if (context.formMode) {
      return [["Ctrl+S", "Save"], ["Esc", "Cancel"], ["Tab", "Next field"], ["Shift+Tab", "Prev field"], ["?", "Help"]];
    }
    if (context.filterOpen) {
      return [["Type", "Filter tasks"], ["Enter", "Apply"], ["Backspace", "Delete char"], ["Esc", "Close"], ["?", "Help"]];
    }
    return [["N", "New"], ["E", "Edit"], ["D", "Delete"], ["F", "Filter"], ["?", "Help"]];
  }

  if (screen === "agents") {
    if (context.confirmKill) {
      return [["Y", "Kill session"], ["N", "Keep session"], ["Esc", "Cancel"], ["?", "Help"]];
    }
    if (context.detailOpen || context.logsOpen || context.diffOpen) {
      return [["Esc", "Close pane"], ["↑/↓", "Change session"], ["L", "Logs"], ["D", "Diff"], ["?", "Help"]];
    }
    return [["↑/↓", "Move"], ["Enter", "Detail"], ["L", "Logs"], ["K", "Kill"], ["?", "Help"]];
  }

  return [["1/2/3", "Switch screens"], ["?", "Help"], ["Q", "Quit"]];
}

export default function HelpScreen({ groups = SHORTCUT_GROUPS, scrollOffset = 0, maxRows = 20 }) {
  const columns = [[], []];
  groups.forEach((group, index) => {
    columns[index % 2].push(group);
  });

  const keyWidth = Math.max(
    12,
    ...groups.flatMap((group) => group.items.map(([keysLabel]) => String(keysLabel || "").length)),
  );

  const renderGroup = (group) => html`
    <${Box} key=${group.title} flexDirection="column" marginBottom=${1}>
      <${Text} bold>${group.title}<//>
      ${group.items.map(([keysLabel, description]) => html`
        <${Box} key=${`${group.title}-${keysLabel}`}>
          <${Text} color="cyan">${String(keysLabel || "").padEnd(keyWidth, " ")}<//>
          <${Text}> ${description}<//>
        <//>
      `)}
    <//>
  `;

  const pairedRows = [];
  for (let index = 0; index < Math.max(columns[0].length, columns[1].length); index += 1) {
    pairedRows.push([columns[0][index] || null, columns[1][index] || null]);
  }

  const visibleRows = pairedRows.slice(scrollOffset, scrollOffset + Math.max(1, maxRows));

  return html`
    <${Box} flexDirection="column" flexGrow=${1} borderStyle="double" paddingX=${1} paddingY=${0}>
      <${Text} bold>Keyboard Shortcuts<//>
      <${Text} dimColor>Press [?] or [Esc] to close • Use ↑/↓ to scroll<//>
      <${Box} flexDirection="column" flexGrow=${1}>
        ${visibleRows.map(([left, right], index) => html`
          <${Box} key=${index} marginTop=${1}>
            <${Box} flexDirection="column" width="50%" paddingRight=${1}>
              ${left ? renderGroup(left) : null}
            <//>
            <${Box} flexDirection="column" width="50%" paddingLeft=${1}>
              ${right ? renderGroup(right) : null}
            <//>
          <//>
        `)}
      <//>
      ${pairedRows.length > visibleRows.length
        ? html`<${Text} dimColor>Showing ${scrollOffset + 1}-${Math.min(pairedRows.length, scrollOffset + visibleRows.length)} of ${pairedRows.length} rows<//>`
        : null}
    <//>
  `;
}
