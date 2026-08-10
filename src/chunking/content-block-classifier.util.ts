import type MarkdownIt from 'markdown-it';
import { ContentBlockType } from './chunking.types';

type Token = MarkdownIt.Token;

// Matches both the older `> **Note:**` bold-text admonition convention and
// GitHub-Flavored-Markdown alert syntax (`> [!NOTE]`, `> [!WARNING]`, etc.)
// — the latter is what Docker's real, current documentation uses throughout;
// the bold-text-only pattern had ~0% recall against real fetched pages.
const NOTE_PATTERN =
  /^\s*(?:\[!(?:note|warning|important|caution|tip)\]|\*{0,2}(?:note|warning|important|caution|tip)\b)/i;

export interface ClassifiedRange {
  type: ContentBlockType;
  endIndex: number;
}

export function classifyRange(
  tokens: Token[],
  index: number,
): ClassifiedRange | null {
  const token = tokens[index];
  if (!token) {
    return null;
  }

  if (token.type === 'fence' || token.type === 'code_block') {
    return { type: 'code', endIndex: index };
  }

  if (token.type === 'table_open') {
    return { type: 'table', endIndex: findMatchingClose(tokens, index) };
  }

  if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
    return { type: 'list', endIndex: findMatchingClose(tokens, index) };
  }

  if (token.type === 'blockquote_open') {
    const endIndex = findMatchingClose(tokens, index);
    const firstInline = findFirstInline(tokens, index, endIndex);
    const type: ContentBlockType =
      firstInline && NOTE_PATTERN.test(firstInline.content)
        ? 'note'
        : 'paragraph';
    return { type, endIndex };
  }

  if (token.type === 'paragraph_open') {
    return { type: 'paragraph', endIndex: findMatchingClose(tokens, index) };
  }

  return null;
}

function findMatchingClose(tokens: Token[], startIndex: number): number {
  const openType = tokens[startIndex]?.type;
  const closeType = openType?.replace(/_open$/, '_close');
  let depth = 0;

  for (let i = startIndex; i < tokens.length; i += 1) {
    const current = tokens[i];
    if (!current) {
      continue;
    }
    if (current.type === openType) {
      depth += 1;
    }
    if (current.type === closeType) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return tokens.length - 1;
}

function findFirstInline(
  tokens: Token[],
  start: number,
  end: number,
): Token | null {
  for (let i = start; i <= end; i += 1) {
    const current = tokens[i];
    if (current?.type === 'inline') {
      return current;
    }
  }
  return null;
}
