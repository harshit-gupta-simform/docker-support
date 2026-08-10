import { ContentBlock, Section } from './chunking.types';
import { SectionSizeBounderService } from './section-size-bounder.service';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

// A stub measurer whose length is always the block's text length in
// characters — deterministic and easy to reason about in test fixtures.
const stubMeasurer = { measure: (text: string) => text.length };

function block(type: ContentBlock['type'], text: string): ContentBlock {
  return { type, text, language: null, length: text.length };
}

function section(
  headingText: string,
  level: number,
  parentPath: { level: number; text: string; anchor: string }[],
  blocks: ContentBlock[],
  children: Section[] = [],
): Section {
  const anchor = headingText.toLowerCase().replace(/\s+/g, '-');
  return {
    headingText,
    headingLevel: level,
    anchor,
    headingPath: [...parentPath, { level, text: headingText, anchor }],
    blocks,
    children,
  };
}

function root(children: Section[]): Section {
  return {
    headingText: '',
    headingLevel: 0,
    anchor: '',
    headingPath: [],
    blocks: [],
    children,
  };
}

describe('SectionSizeBounderService', () => {
  const service = new SectionSizeBounderService(
    stubMeasurer,
    buildLogger() as never,
  );

  it('emits one piece for a section within size bounds', () => {
    const doc = root([
      section('Intro', 1, [], [block('paragraph', 'short text')]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 100, minChunkSize: 5 });

    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.wasSplit).toBe(false);
    expect(pieces[0]?.wasMerged).toBe(false);
    expect(pieces[0]?.text).toContain('short text');
  });

  it('splits an oversized section into multiple pieces at block boundaries', () => {
    const doc = root([
      section(
        'Big',
        1,
        [],
        [
          block('paragraph', 'a'.repeat(30)),
          block('paragraph', 'b'.repeat(30)),
          block('paragraph', 'c'.repeat(30)),
        ],
      ),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 40, minChunkSize: 5 });

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.wasSplit)).toBe(true);
    expect(pieces.map((p) => p.localSequenceIndex)).toEqual(
      pieces.map((_, i) => i),
    );
  });

  it('keeps an oversized code block intact and flags exceedsMaxSize', () => {
    const doc = root([
      section(
        'Code',
        1,
        [],
        [block('code', '```\n' + 'x'.repeat(100) + '\n```')],
      ),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 20, minChunkSize: 5 });

    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.exceedsMaxSize).toBe(true);
    expect(pieces[0]?.text).toContain('x'.repeat(100));
  });

  it('merges two adjacent undersized siblings under the same parent', () => {
    const doc = root([
      section('A', 1, [], [block('paragraph', 'short')]),
      section('B', 1, [], [block('paragraph', 'also short')]),
    ]);

    const pieces = service.bound(doc, {
      maxChunkSize: 1000,
      minChunkSize: 50,
    });

    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.wasMerged).toBe(true);
    expect(pieces[0]?.mergedHeadings).toEqual(['B']);
    expect(pieces[0]?.text).toContain('short');
    expect(pieces[0]?.text).toContain('also short');
  });

  it('never merges two undersized sections that have different parents', () => {
    // Parent1/Parent2 each carry enough of their own content to be
    // ineligible for merging themselves (their own length exceeds
    // minChunkSize), isolating this test to A and B — each is the sole
    // child of its own parent, so neither ever shares a sibling group with
    // the other and neither can ever be merged with anything.
    const doc = root([
      section(
        'Parent1',
        1,
        [],
        [block('paragraph', 'x'.repeat(60))],
        [
          section(
            'A',
            2,
            [{ level: 1, text: 'Parent1', anchor: 'parent1' }],
            [block('paragraph', 'tiny')],
          ),
        ],
      ),
      section(
        'Parent2',
        1,
        [],
        [block('paragraph', 'y'.repeat(60))],
        [
          section(
            'B',
            2,
            [{ level: 1, text: 'Parent2', anchor: 'parent2' }],
            [block('paragraph', 'tiny too')],
          ),
        ],
      ),
    ]);

    const pieces = service.bound(doc, {
      maxChunkSize: 1000,
      minChunkSize: 50,
    });
    const merged = pieces.filter((p) => p.wasMerged);

    expect(merged).toHaveLength(0);
  });

  it('never folds an undersized section into a normal-sized adjacent sibling', () => {
    const doc = root([
      section('Normal', 1, [], [block('paragraph', 'x'.repeat(60))]),
      section('Tiny', 1, [], [block('paragraph', 'tiny')]),
    ]);

    const pieces = service.bound(doc, {
      maxChunkSize: 1000,
      minChunkSize: 50,
    });
    const normalPiece = pieces.find((p) => p.text.includes('x'.repeat(60)));

    expect(normalPiece?.wasMerged).toBe(false);
    expect(normalPiece?.text).not.toContain('tiny');
    expect(pieces).toHaveLength(2);
  });

  it('splits a run of undersized siblings into two groups when combined length would exceed maxChunkSize', () => {
    // Each section's own length is 13 (10-char body + 3-char heading line):
    // ineligible alone (< minChunkSize 20) but two together (26) fit under
    // maxChunkSize (30) while three together (39) would not — so A+B should
    // merge into one piece and C should be left as its own single piece,
    // rather than all three folding into one oversized chunk.
    const doc = root([
      section('A', 1, [], [block('paragraph', 'a'.repeat(10))]),
      section('B', 1, [], [block('paragraph', 'b'.repeat(10))]),
      section('C', 1, [], [block('paragraph', 'c'.repeat(10))]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 30, minChunkSize: 20 });
    const mergedPieces = pieces.filter((p) => p.wasMerged);

    expect(pieces).toHaveLength(2);
    expect(mergedPieces).toHaveLength(1);
    expect(mergedPieces[0]?.mergedHeadings).toEqual(['B']);
    expect(pieces.every((p) => p.length <= 30)).toBe(true);
  });

  it('keeps a single oversized list item intact with exceedsMaxSize true', () => {
    const bigItem = 'x'.repeat(100);
    const listBlock: ContentBlock = {
      type: 'list',
      text: `- ${bigItem}\n- short`,
      language: null,
      length: `- ${bigItem}\n- short`.length,
      itemTexts: [`- ${bigItem}`, '- short'],
    };
    const doc = root([section('List', 1, [], [listBlock])]);

    const pieces = service.bound(doc, { maxChunkSize: 20, minChunkSize: 5 });

    const oversizedPiece = pieces.find((p) => p.text.includes(bigItem));
    expect(oversizedPiece?.exceedsMaxSize).toBe(true);
  });

  it('splits an oversized table by row and repeats the header in each piece', () => {
    const header = '| A | B |\n| --- | --- |';
    const rows = ['| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'];
    const tableBlock: ContentBlock = {
      type: 'table',
      text: [header, ...rows].join('\n'),
      language: null,
      length: [header, ...rows].join('\n').length,
      headerText: header,
      rowTexts: rows,
    };
    const doc = root([section('Table', 1, [], [tableBlock])]);

    const pieces = service.bound(doc, { maxChunkSize: 40, minChunkSize: 5 });

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.text).toContain(header);
    }
  });

  it('resolves nested children after a merged sibling group, preserving document order', () => {
    const doc = root([
      section(
        'A',
        1,
        [],
        [block('paragraph', 'tiny a')],
        [
          section(
            'A-Child',
            2,
            [{ level: 1, text: 'A', anchor: 'a' }],
            [block('paragraph', 'a child body')],
          ),
        ],
      ),
      section('B', 1, [], [block('paragraph', 'tiny b')]),
    ]);

    const pieces = service.bound(doc, {
      maxChunkSize: 1000,
      minChunkSize: 50,
    });

    expect(pieces[0]?.wasMerged).toBe(true);
    expect(pieces[1]?.text).toContain('a child body');
  });
});
