const CHARS_PER_APPROX_TOKEN = 4;

// Deliberately duplicates the embedding module's approx-token heuristic
// (src/embedding/embedding-input-builder.util.ts) rather than importing it —
// src/generation/ must stay independent of src/embedding/'s runtime code.
export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenPricing {
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}

export function calculateCostUsd(
  usage: TokenUsage,
  pricing: TokenPricing,
): number {
  const inputCost =
    (usage.inputTokens / 1_000_000) * pricing.inputPricePerMillionTokens;
  const outputCost =
    (usage.outputTokens / 1_000_000) * pricing.outputPricePerMillionTokens;
  return inputCost + outputCost;
}
