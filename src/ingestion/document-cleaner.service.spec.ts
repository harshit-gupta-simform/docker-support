import { DocumentCleanerService } from './document-cleaner.service';
import { RawFile } from './ingestion.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function rawFile(content: string): RawFile {
  return {
    sourcePath: 'docs/intro.md',
    content: Buffer.from(content, 'utf-8'),
    uncompressedSize: content.length,
    compressedSize: content.length,
    lastModified: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('DocumentCleanerService', () => {
  const service = new DocumentCleanerService(buildLogger() as never);

  it('separates front matter from body text', () => {
    const result = service.clean(
      rawFile('---\ntitle: Intro\nlang: en\n---\n\nHello world.'),
    );

    expect(result.frontMatter).toEqual({ title: 'Intro', lang: 'en' });
    expect(result.text).toBe('Hello world.');
  });

  it('returns an empty front matter object when none is present', () => {
    const result = service.clean(rawFile('Just plain text.'));

    expect(result.frontMatter).toEqual({});
    expect(result.text).toBe('Just plain text.');
  });

  it('normalizes CRLF line endings to LF', () => {
    const result = service.clean(rawFile('Line one.\r\nLine two.'));

    expect(result.text).toBe('Line one.\nLine two.');
  });

  it('collapses three or more consecutive blank lines into one blank line', () => {
    const result = service.clean(rawFile('Para one.\n\n\n\nPara two.'));

    expect(result.text).toBe('Para one.\n\nPara two.');
  });

  it('trims leading and trailing whitespace from the body', () => {
    const result = service.clean(rawFile('\n\n  Hello.  \n\n'));

    expect(result.text).toBe('Hello.');
  });

  it('preserves the source path on the cleaned file', () => {
    const result = service.clean(rawFile('Text.'));

    expect(result.sourcePath).toBe('docs/intro.md');
  });
});
