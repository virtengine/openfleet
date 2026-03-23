function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}

export function scoreFuzzyMatch(query = "", candidate = "") {
  const normalizedQuery = normalizeText(query);
  const normalizedCandidate = normalizeText(candidate);

  if (!normalizedQuery) return 0;
  if (!normalizedCandidate) return Number.NEGATIVE_INFINITY;

  let score = 0;
  let searchIndex = 0;
  let previousMatchIndex = -1;
  let matchedChars = 0;

  for (const char of normalizedQuery) {
    const matchIndex = normalizedCandidate.indexOf(char, searchIndex);
    if (matchIndex < 0) break;

    matchedChars += 1;
    score += 1;
    if (matchIndex === 0) score += 8;
    if (matchIndex === previousMatchIndex + 1) score += 6;
    if (matchIndex === searchIndex) score += 3;
    if (matchIndex === 0 || /[\s_-]/.test(normalizedCandidate[matchIndex - 1] || "")) score += 5;
    score += Math.max(0, 4 - Math.min(matchIndex, 4));

    previousMatchIndex = matchIndex;
    searchIndex = matchIndex + 1;
  }

  if (matchedChars === normalizedQuery.length) {
    score += 100;
  } else {
    const partialChars = new Set(normalizedQuery).size;
    score += matchedChars * 12;
    score += Math.max(0, partialChars - normalizedCandidate.length / 100);
  }

  score += Math.max(0, 12 - (normalizedCandidate.length - matchedChars));
  return score;
}

export function rankFuzzyMatches(query, candidates = [], getValue = (candidate) => candidate) {
  return [...(Array.isArray(candidates) ? candidates : [])]
    .map((candidate) => ({
      item: candidate,
      candidate,
      value: String(getValue(candidate) || ""),
      score: scoreFuzzyMatch(query, getValue(candidate)),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.value.localeCompare(right.value);
    });
}
