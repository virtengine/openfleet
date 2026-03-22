export function nowISO() {
  return new Date().toISOString();
}

export function toStringArray(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item || '').trim()).filter(Boolean);
}

export function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}