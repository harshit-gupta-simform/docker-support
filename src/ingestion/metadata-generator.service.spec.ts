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
