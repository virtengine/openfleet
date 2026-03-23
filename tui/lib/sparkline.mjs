const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function renderSparkline(values = [], { min = null, max = null } = {}) {
  const numericValues = Array.isArray(values)
    ? values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    : [];

  if (!numericValues.length) return "";

  const resolvedMin = min == null ? Math.min(...numericValues) : Number(min);
  const resolvedMax = max == null ? Math.max(...numericValues) : Number(max);
  const range = resolvedMax - resolvedMin;

  if (range <= 0) {
    return numericValues.map(() => BLOCKS[BLOCKS.length - 1]).join("");
  }

  return numericValues.map((value) => {
    const ratio = (value - resolvedMin) / range;
    const index = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(ratio * (BLOCKS.length - 1))));
    return BLOCKS[index];
  }).join("");
}

export { BLOCKS as SPARKLINE_BLOCKS };
