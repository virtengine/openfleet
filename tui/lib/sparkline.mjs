const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function renderSparkline(values = [], { min = null, max = null } = {}) {
  const numericValues = Array.isArray(values)
    ? values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    : [];

  if (!numericValues.length) return "";

  let resolvedMin = min == null ? Infinity : Number(min);
  let resolvedMax = max == null ? -Infinity : Number(max);

  if (min == null || max == null) {
    for (const value of numericValues) {
      if (min == null && value < resolvedMin) {
        resolvedMin = value;
      }
      if (max == null && value > resolvedMax) {
        resolvedMax = value;
      }
    }
  }
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
