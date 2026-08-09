import { matchesGlob } from './glob-match.util';

describe('matchesGlob', () => {
  it('matches a nested file against **/*.md', () => {
    expect(matchesGlob('docs/guide/intro.md', '**/*.md')).toBe(true);
  });

  it('matches a top-level file against **/*.md', () => {
    expect(matchesGlob('readme.md', '**/*.md')).toBe(true);
  });

  it('does not match a non-matching extension', () => {
    expect(matchesGlob('docs/intro.txt', '**/*.md')).toBe(false);
  });

  it('matches a single-segment wildcard within one directory level', () => {
    expect(matchesGlob('docs/intro.md', 'docs/*.md')).toBe(true);
  });

  it('does not let a single-segment wildcard cross directories', () => {
    expect(matchesGlob('docs/guide/intro.md', 'docs/*.md')).toBe(false);
  });

  it('matches an exact literal pattern', () => {
    expect(matchesGlob('readme.md', 'readme.md')).toBe(true);
  });
});
