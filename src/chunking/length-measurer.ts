export const LENGTH_MEASURER_PORT = Symbol('LENGTH_MEASURER_PORT');

export interface LengthMeasurerPort {
  measure(text: string): number;
}

export class CharLengthMeasurer implements LengthMeasurerPort {
  measure(text: string): number {
    return text.length;
  }
}

export class WordLengthMeasurer implements LengthMeasurerPort {
  measure(text: string): number {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return 0;
    }
    return trimmed.split(/\s+/).filter((word) => word.length > 0).length;
  }
}

const CHARS_PER_APPROX_TOKEN = 4;

export class ApproxTokenLengthMeasurer implements LengthMeasurerPort {
  measure(text: string): number {
    return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
  }
}

export type LengthStrategy = 'char' | 'word' | 'approx-token';

export function createLengthMeasurer(
  strategy: LengthStrategy,
): LengthMeasurerPort {
  switch (strategy) {
    case 'char':
      return new CharLengthMeasurer();
    case 'word':
      return new WordLengthMeasurer();
    case 'approx-token':
      return new ApproxTokenLengthMeasurer();
  }
}
