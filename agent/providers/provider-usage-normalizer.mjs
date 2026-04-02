export function normalizeProviderUsageMetadata(usage = {}) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(
    usage.inputTokens
      ?? usage.promptTokens
      ?? usage.prompt_tokens
      ?? usage.input_tokens
      ?? 0,
  );
  const outputTokens = Number(
    usage.outputTokens
      ?? usage.completionTokens
      ?? usage.completion_tokens
      ?? usage.output_tokens
      ?? 0,
  );
  const totalTokens = Number(
    usage.totalTokens
      ?? usage.total_tokens
      ?? inputTokens + outputTokens,
  );
  const costUsd = Number(
    usage.costUsd
      ?? usage.costUSD
      ?? usage.cost_usd
      ?? usage.cost
      ?? 0,
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    raw: JSON.parse(JSON.stringify(usage)),
  };
}

export default normalizeProviderUsageMetadata;
