import {
  ApproxTokenLengthMeasurer,
  CharLengthMeasurer,
  createLengthMeasurer,
  WordLengthMeasurer,
} from './length-measurer';

describe('CharLengthMeasurer', () => {
  it('measures raw character length', () => {
    expect(new CharLengthMeasurer().measure('hello')).toBe(5);
  });
});

describe('WordLengthMeasurer', () => {
  it('counts whitespace-separated words', () => {
    expect(new WordLengthMeasurer().measure('one two  three')).toBe(3);
  });

  it('returns 0 for empty or whitespace-only text', () => {
    expect(new WordLengthMeasurer().measure('   ')).toBe(0);
  });
});

describe('ApproxTokenLengthMeasurer', () => {
  it('approximates ~4 characters per token, rounded up', () => {
    expect(new ApproxTokenLengthMeasurer().measure('12345678')).toBe(2);
    expect(new ApproxTokenLengthMeasurer().measure('123456789')).toBe(3);
  });

  it('returns 0 for empty text', () => {
    expect(new ApproxTokenLengthMeasurer().measure('')).toBe(0);
  });
});

describe('createLengthMeasurer', () => {
  it('creates a CharLengthMeasurer for "char"', () => {
    expect(createLengthMeasurer('char')).toBeInstanceOf(CharLengthMeasurer);
  });

  it('creates a WordLengthMeasurer for "word"', () => {
    expect(createLengthMeasurer('word')).toBeInstanceOf(WordLengthMeasurer);
  });

  it('creates an ApproxTokenLengthMeasurer for "approx-token"', () => {
    expect(createLengthMeasurer('approx-token')).toBeInstanceOf(
      ApproxTokenLengthMeasurer,
    );
  });
});
