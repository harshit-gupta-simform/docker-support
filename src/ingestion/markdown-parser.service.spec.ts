import { MarkdownParserService } from './markdown-parser.service';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

describe('MarkdownParserService', () => {
  const service = new MarkdownParserService(buildLogger() as never);

  it('extracts the title from the first H1 heading', () => {
    const result = service.parse('a.md', '# My Title\n\nBody text.');

    expect(result.title).toBe('My Title');
  });

  it('falls back to the source path as title when there is no H1', () => {
    const result = service.parse('a.md', 'No headings here.');

    expect(result.title).toBe('a.md');
  });

  it('builds a nested heading tree respecting heading levels', () => {
    const result = service.parse(
      'a.md',
      '# Top\n\n## Child\n\n### Grandchild\n\n## Second Child',
    );

    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]?.text).toBe('Top');
    expect(result.headings[0]?.children).toHaveLength(2);
    expect(result.headings[0]?.children[0]?.text).toBe('Child');
    expect(result.headings[0]?.children[0]?.children[0]?.text).toBe(
      'Grandchild',
    );
    expect(result.headings[0]?.children[1]?.text).toBe('Second Child');
  });

  it('slugifies heading text into an anchor', () => {
    const result = service.parse('a.md', '# Hello, World! Docker Setup');

    expect(result.headings[0]?.anchor).toBe('hello-world-docker-setup');
  });

  it('extracts fenced code blocks with their language and position', () => {
    const result = service.parse(
      'a.md',
      '```bash\necho hi\n```\n\nText.\n\n```\nno lang\n```',
    );

    expect(result.codeBlocks).toHaveLength(2);
    expect(result.codeBlocks[0]).toEqual({
      language: 'bash',
      content: 'echo hi\n',
      position: 0,
    });
    expect(result.codeBlocks[1]?.language).toBeNull();
    expect(result.codeBlocks[1]?.position).toBe(1);
  });

  it('extracts link hrefs', () => {
    const result = service.parse(
      'a.md',
      'See [Docker docs](https://docs.docker.com) for more.',
    );

    expect(result.links).toEqual(['https://docs.docker.com']);
  });

  it('preserves the source path and full cleaned text as bodyText', () => {
    const result = service.parse('a.md', '# T\n\nBody.');

    expect(result.sourcePath).toBe('a.md');
    expect(result.bodyText).toBe('# T\n\nBody.');
  });
});
