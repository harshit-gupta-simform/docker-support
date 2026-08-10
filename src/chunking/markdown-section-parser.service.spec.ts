import { CharLengthMeasurer } from './length-measurer';
import { MarkdownSectionParserService } from './markdown-section-parser.service';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

describe('MarkdownSectionParserService', () => {
  const service = new MarkdownSectionParserService(
    new CharLengthMeasurer(),
    buildLogger() as never,
  );

  it('puts content before the first heading into the implicit root section', () => {
    const root = service.parse('Intro text.\n\n# First Heading\n\nBody.');

    expect(root.headingLevel).toBe(0);
    expect(root.headingPath).toEqual([]);
    expect(root.blocks).toHaveLength(1);
    expect(root.blocks[0]?.text).toContain('Intro text.');
    expect(root.children).toHaveLength(1);
  });

  it('builds a flat single-level document correctly', () => {
    const root = service.parse('# Title\n\nSome text.');

    expect(root.children).toHaveLength(1);
    const section = root.children[0]!;
    expect(section.headingText).toBe('Title');
    expect(section.headingLevel).toBe(1);
    expect(section.headingPath).toEqual([
      { level: 1, text: 'Title', anchor: 'title' },
    ]);
    expect(section.blocks).toHaveLength(1);
    expect(section.blocks[0]?.type).toBe('paragraph');
  });

  it('nests a 3-level document and accumulates headingPath correctly', () => {
    const root = service.parse(
      '# Top\n\nTop body.\n\n## Child\n\nChild body.\n\n### Grandchild\n\nGrandchild body.',
    );

    const top = root.children[0]!;
    const child = top.children[0]!;
    const grandchild = child.children[0]!;

    expect(top.headingPath).toEqual([{ level: 1, text: 'Top', anchor: 'top' }]);
    expect(child.headingPath).toEqual([
      { level: 1, text: 'Top', anchor: 'top' },
      { level: 2, text: 'Child', anchor: 'child' },
    ]);
    expect(grandchild.headingPath).toEqual([
      { level: 1, text: 'Top', anchor: 'top' },
      { level: 2, text: 'Child', anchor: 'child' },
      { level: 3, text: 'Grandchild', anchor: 'grandchild' },
    ]);
    expect(child.blocks[0]?.text).toContain('Child body.');
    expect(grandchild.blocks[0]?.text).toContain('Grandchild body.');
  });

  it('gives a heading with no content before the next heading an empty blocks array', () => {
    const root = service.parse('# Empty\n\n## Next\n\nText.');

    expect(root.children[0]?.blocks).toEqual([]);
  });

  it('does not misparse a heading-like line inside a fenced code block', () => {
    const root = service.parse(
      '# Real Heading\n\n```\n# not a real heading\n```',
    );

    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.headingText).toBe('Real Heading');
    expect(root.children[0]?.blocks).toHaveLength(1);
    expect(root.children[0]?.blocks[0]?.type).toBe('code');
  });

  it('classifies a fenced code block with its language', () => {
    const root = service.parse('# T\n\n```bash\ndocker --version\n```');

    const block = root.children[0]!.blocks[0]!;
    expect(block.type).toBe('code');
    expect(block.language).toBe('bash');
    expect(block.text).toContain('docker --version');
    expect(block.text.startsWith('```bash')).toBe(true);
  });

  it('keeps a nested sub-list inside its top-level list block, not as a separate block', () => {
    const root = service.parse(
      '# T\n\n- one\n  - nested one\n  - nested two\n- two',
    );

    const blocks = root.children[0]!.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('list');
    expect(blocks[0]?.text).toContain('nested one');
  });

  it('extracts one itemText per top-level list item, in order', () => {
    const root = service.parse('# T\n\n- one\n- two\n- three');

    const block = root.children[0]!.blocks[0]!;
    expect(block.itemTexts).toEqual(['- one', '- two', '- three']);
  });

  it('reconstructs a table block byte-identically from the source', () => {
    const source = '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const root = service.parse(source);

    const block = root.children[0]!.blocks[0]!;
    expect(block.type).toBe('table');
    expect(block.text).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('extracts headerText (including the separator row) and rowTexts separately for a table', () => {
    const source = '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    const root = service.parse(source);

    const block = root.children[0]!.blocks[0]!;
    expect(block.headerText).toBe('| A | B |\n| --- | --- |');
    expect(block.rowTexts).toEqual(['| 1 | 2 |', '| 3 | 4 |']);
  });

  it('measures each block length via the injected LengthMeasurerPort', () => {
    const root = service.parse('# T\n\nHello.');

    const block = root.children[0]!.blocks[0]!;
    expect(block.length).toBe(block.text.length);
  });
});
