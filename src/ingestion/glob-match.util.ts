const REGEX_SPECIAL_CHARS = new Set([
  '.',
  '+',
  '^',
  '$',
  '{',
  '}',
  '(',
  ')',
  '|',
  '[',
  ']',
  '\\',
]);

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*' && pattern[i + 1] === '*') {
      result += '.*';
      i += 2;
      if (pattern[i] === '/') {
        i += 1;
      }
      continue;
    }

    if (char === '*') {
      result += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      result += '[^/]';
      i += 1;
      continue;
    }

    if (char !== undefined && REGEX_SPECIAL_CHARS.has(char)) {
      result += `\\${char}`;
      i += 1;
      continue;
    }

    result += char;
    i += 1;
  }

  return new RegExp(`^${result}$`);
}
