export function flattenSettingsRows(sections = []) {
  const rows = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    rows.push({
      kind: "section",
      id: `section:${section.id}`,
      label: section.label,
    });
    for (const item of Array.isArray(section.items) ? section.items : []) {
      rows.push(item);
    }
  }
  return rows;
}

export function getSelectableSettingRows(rows = []) {
  return rows.filter((row) => row?.kind === "field");
}

export function maskValue(valueText = "") {
  return valueText ? "****" : "";
}

export function formatRenderedValue(field, unmaskedPaths = new Set()) {
  if (field?.masked && !unmaskedPaths.has(field.path)) {
    return maskValue(field?.valueText || "");
  }
  const valueText = String(field?.valueText || "");
  return valueText || "(unset)";
}

export function formatSourceLabel(field) {
  return String(field?.sourceLabel || "default");
}

export function cycleEnumValue(field, direction = 1) {
  const options = Array.isArray(field?.enumValues) ? field.enumValues : [];
  if (options.length === 0) return null;
  const current = String(field?.valueText || "");
  const currentIndex = Math.max(0, options.findIndex((option) => String(option) === current));
  const nextIndex = (currentIndex + direction + options.length) % options.length;
  return String(options[nextIndex]);
}

export function toggleBooleanValue(field) {
  const current = String(field?.valueText || "").trim().toLowerCase();
  return current === "true" ? "false" : "true";
}

export function buildFooterHints({ editing = false, selectedField = null } = {}) {
  if (editing) {
    return [
      ["Ctrl+S", "Save"],
      ["Esc", "Cancel"],
    ];
  }

  const hints = [
    ["↑/↓", "Move"],
    ["Enter", "Edit"],
    ["R", "Reload"],
  ];

  if (selectedField?.editorKind === "boolean" && !selectedField?.readOnly) {
    hints.push(["Space", "Toggle"]);
  }
  if (selectedField?.editorKind === "enum" && !selectedField?.readOnly) {
    hints.push(["←/→", "Cycle"]);
  }
  if (selectedField?.masked) {
    hints.push(["U", "Unmask"]);
  }

  return hints;
}
