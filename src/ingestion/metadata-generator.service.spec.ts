import { createHash } from 'node:crypto';
import { IngestionConfigService } from './ingestion-config.service';
import { MetadataGeneratorService } from './metadata-generator.service';
import { ParsedDocument } from './ingestion.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function buildConfig(defaultLanguage = 'en'): IngestionConfigService {
  return { defaultLanguage } as IngestionConfigService;
}

function parsedDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    sourcePath: 'docs/intro.md',
    title: 'Intro',
    headings: [],
    bodyText: 'Hello world.',
    codeBlocks: [],
    links: [],
    ...overrides,
  };
}

describe('MetadataGeneratorService', () => {
  const service = new MetadataGeneratorService(
    buildConfig(),
    buildLogger() as never,
  );

  it('computes a SHA-256 hash of the cleaned text', () => {
    const cleanedText = 'Hello world.';
    const expectedHash = createHash('sha256')
      .update(cleanedText, 'utf-8')
      .digest('hex');

    const metadata = service.generate(parsedDoc(), cleanedText, {});

    expect(metadata.contentHash).toBe(expectedHash);
  });

  it('counts words in the cleaned text', () => {
    const metadata = service.generate(parsedDoc(), 'one two three four', {});

    expect(metadata.wordCount).toBe(4);
  });

  it('uses the front-matter lang field when present', () => {
    const metadata = service.generate(parsedDoc(), 'text', { lang: 'fr' });

    expect(metadata.language).toBe('fr');
  });

  it('uses the front-matter language field when lang is absent', () => {
    const metadata = service.generate(parsedDoc(), 'text', {
      language: 'de',
    });

    expect(metadata.language).toBe('de');
  });

  it('falls back to the configured default language when front matter has none', () => {
    const metadata = service.generate(parsedDoc(), 'text', {});

    expect(metadata.language).toBe('en');
  });

  it('prefers the front-matter title over the parsed body title', () => {
    // Regression test for a bug found via real-data testing: Hugo-based
    // documentation sites (like Docker's actual docs) put the canonical
    // title only in front matter and rarely repeat it as a body H1, so
    // relying on the body-derived title alone silently produced the raw
    // sourcePath as "title" for ~97% of a real Docker docs corpus.
    const parsed = parsedDoc({ title: 'Body Heading', sourcePath: 'a.md' });

    const metadata = service.generate(parsed, 'text', {
      title: 'Use IPv6 networking',
    });

    expect(metadata.title).toBe('Use IPv6 networking');
  });

  it('falls back to the parsed body title when front matter has no title', () => {
    const parsed = parsedDoc({ title: 'Body Heading' });

    const metadata = service.generate(parsed, 'text', { description: 'x' });

    expect(metadata.title).toBe('Body Heading');
  });

  it('falls back to the parsed body title when front-matter title is not a string', () => {
    const parsed = parsedDoc({ title: 'Body Heading' });

    const metadata = service.generate(parsed, 'text', { title: 42 });

    expect(metadata.title).toBe('Body Heading');
  });

  it('falls back to the parsed body title when front-matter title is an empty string', () => {
    const parsed = parsedDoc({ title: 'Body Heading' });

    const metadata = service.generate(parsed, 'text', { title: '' });

    expect(metadata.title).toBe('Body Heading');
  });

  it('falls back all the way to sourcePath when there is neither a front-matter title nor a body H1', () => {
    // parsed.title is already H1-or-sourcePath by the time it reaches this
    // service (MarkdownParserService's own contract) — this documents that
    // the full 3-tier fallback (frontMatter.title -> H1 -> sourcePath)
    // still resolves correctly end-to-end.
    const parsed = parsedDoc({ title: 'no-h1.md', sourcePath: 'no-h1.md' });

    const metadata = service.generate(parsed, 'text', {});

    expect(metadata.title).toBe('no-h1.md');
  });

  it('copies title, sourcePath, and headingOutline from the parsed document', () => {
    const parsed = parsedDoc({
      title: 'My Doc',
      sourcePath: 'x.md',
      headings: [{ level: 1, text: 'My Doc', anchor: 'my-doc', children: [] }],
    });

    const metadata = service.generate(parsed, 'text', {});

    expect(metadata.title).toBe('My Doc');
    expect(metadata.sourcePath).toBe('x.md');
    expect(metadata.headingOutline).toBe(parsed.headings);
  });

  it('passes front matter through unchanged', () => {
    const frontMatter = { title: 'X', tags: ['a', 'b'] };

    const metadata = service.generate(parsedDoc(), 'text', frontMatter);

    expect(metadata.frontMatter).toEqual(frontMatter);
  });

  it('stamps extractedAt as an ISO timestamp', () => {
    const metadata = service.generate(parsedDoc(), 'text', {});

    expect(new Date(metadata.extractedAt).toISOString()).toBe(
      metadata.extractedAt,
    );
  });
});
