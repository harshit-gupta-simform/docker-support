import { calculateCostUsd, estimateTokenCount } from './token-usage.util';

describe('estimateTokenCount', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('estimates roughly 1 token per 4 characters, rounded up', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('abcde')).toBe(2);
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
  });
});

describe('calculateCostUsd', () => {
  it('sums input and output cost components using per-million prices', () => {
    const cost = calculateCostUsd(
      { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      { inputPricePerMillionTokens: 0.75, outputPricePerMillionTokens: 3.75 },
    );
    expect(cost).toBeCloseTo(0.000075 + 0.00075, 10);
  });

  it('returns 0 for zero token usage', () => {
    const cost = calculateCostUsd(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { inputPricePerMillionTokens: 0.75, outputPricePerMillionTokens: 3.75 },
    );
    expect(cost).toBe(0);
  });
});
