const MOJIBAKE_REPLACEMENTS = Object.freeze([
  ["ÔÇö", "—"],
  ["ÔåÆ", "→"],
  ["ÔÇª", "…"],
  ["ÔÇ£", "“"],
  ["ÔÇ¥", "”"],
  ["ÔÇÖ", "’"],
  ["ÔÇ˜", "‘"],
  ["ÔÇ¢", "•"],
  ["ÔöÇ", "✓"],
  ["â€”", "—"],
  ["â€“", "–"],
  ["â€¦", "…"],
  ["â€œ", "“"],
  ["â€\u009d", "”"],
  ["â€˜", "‘"],
  ["â€™", "’"],
  ["â€¢", "•"],
  ["â†’", "→"],
  ["âœ“", "✓"],
]);

function repairCommonMojibake(value = "") {
  let repaired = String(value ?? "");
  for (const [broken, fixed] of MOJIBAKE_REPLACEMENTS) {
    if (!repaired.includes(broken)) continue;
    repaired = repaired.split(broken).join(fixed);
  }
  return repaired;
}

function detectCommonMojibake(value = "") {
  const text = String(value ?? "");
  return MOJIBAKE_REPLACEMENTS.some(([broken]) => text.includes(broken));
}

export {
  detectCommonMojibake,
  repairCommonMojibake,
};
