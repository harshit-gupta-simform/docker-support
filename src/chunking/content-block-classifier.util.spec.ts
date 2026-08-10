import MarkdownIt from 'markdown-it';
import { classifyRange } from './content-block-classifier.util';

const markdownIt = new MarkdownIt();

describe('classifyRange', () => {
  it('classifies a fenced code block as code', () => {
    const tokens = markdownIt.parse('```bash\necho hi\n```\n', {});
    const result = classifyRange(tokens, 0);

    expect(result).toEqual({ type: 'code', endIndex: 0 });
  });

  it('classifies a GFM table as table', () => {
    const tokens = markdownIt.parse(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
      {},
    );
    const tableOpenIndex = tokens.findIndex((t) => t.type === 'table_open');
    const tableCloseIndex = tokens.findIndex((t) => t.type === 'table_close');
    const result = classifyRange(tokens, tableOpenIndex);

    expect(result).toEqual({ type: 'table', endIndex: tableCloseIndex });
  });

  it('classifies a bullet list as list', () => {
    const tokens = markdownIt.parse('- one\n- two\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'bullet_list_open');
    const closeIndex = tokens.findIndex((t) => t.type === 'bullet_list_close');
    const result = classifyRange(tokens, openIndex);

    expect(result).toEqual({ type: 'list', endIndex: closeIndex });
  });

  it('classifies an ordered list as list', () => {
    const tokens = markdownIt.parse('1. one\n2. two\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'ordered_list_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('list');
  });

  it('classifies a bold "Note:" blockquote as note', () => {
    const tokens = markdownIt.parse('> **Note:** be careful\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'blockquote_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('note');
  });

  it('classifies a plain, non-admonition blockquote as paragraph', () => {
    const tokens = markdownIt.parse('> just a quote\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'blockquote_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('paragraph');
  });

  it('classifies a plain paragraph as paragraph', () => {
    const tokens = markdownIt.parse('Just some text.\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'paragraph_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('paragraph');
  });

  it('returns null for a heading_open token (not a content block)', () => {
    const tokens = markdownIt.parse('# Title\n', {});
    const result = classifyRange(tokens, 0);

    expect(result).toBeNull();
  });

  it('returns null for an inline token seen outside a recognized container', () => {
    const tokens = markdownIt.parse('# Title\n', {});
    const inlineIndex = tokens.findIndex((t) => t.type === 'inline');
    const result = classifyRange(tokens, inlineIndex);

    expect(result).toBeNull();
  });
});
