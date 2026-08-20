import { validateQueryText } from './query-request.validator';

describe('validateQueryText', () => {
  it('returns the trimmed text for a valid string', () => {
    expect(validateQueryText('  how do I install docker?  ')).toBe(
      'how do I install docker?',
    );
  });

  it('throws when text is missing', () => {
    expect(() => validateQueryText(undefined)).toThrow();
  });

  it('throws when text is not a string', () => {
    expect(() => validateQueryText(42)).toThrow();
  });

  it('throws when text is empty or whitespace-only', () => {
    expect(() => validateQueryText('   ')).toThrow();
  });

  it('throws when text exceeds the maximum length', () => {
    expect(() => validateQueryText('x'.repeat(2001))).toThrow();
  });

  it('accepts text at exactly the maximum length', () => {
    const text = 'x'.repeat(2000);
    expect(validateQueryText(text)).toBe(text);
  });
});
