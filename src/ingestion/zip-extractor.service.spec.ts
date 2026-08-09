import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArchiveCorruptError,
  ArchiveSizeLimitExceededError,
} from './ingestion.errors';
import { IngestionConfigService } from './ingestion-config.service';
import { ZipExtractorService } from './zip-extractor.service';

function buildConfig(overrides: {
  maxEntryCount?: number;
  maxUncompressedBytes?: number;
  includeGlob?: string;
}): IngestionConfigService {
  return {
    maxEntryCount: overrides.maxEntryCount ?? 10000,
    maxUncompressedBytes: overrides.maxUncompressedBytes ?? 524288000,
    includeGlob: overrides.includeGlob ?? '**/*.md',
  } as IngestionConfigService;
}

function buildLogger(): {
  setContext: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
}

async function buildZipFixture(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'zip-extractor-test-'));
  const zipPath = join(dir, 'fixture.zip');

  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(join(dir, relativePath), content, 'utf-8');
  }

  execFileSync('zip', ['-q', '-r', zipPath, ...Object.keys(files)], {
    cwd: dir,
  });

  const buffer = await readFile(zipPath);
  await rm(dir, { recursive: true, force: true });
  return buffer;
}

describe('ZipExtractorService', () => {
  it('extracts entries matching the include glob and skips non-matching ones', async () => {
    const buffer = await buildZipFixture({
      'intro.md': '# Intro',
      'notes.txt': 'not markdown',
    });
    const service = new ZipExtractorService(
      buildConfig({}),
      buildLogger() as never,
    );

    const result = await service.extract(buffer);

    expect(result.totalEntries).toBe(2);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.sourcePath).toBe('intro.md');
    expect(result.files[0]?.content.toString('utf-8')).toBe('# Intro');
  });

  it('rejects an archive declaring more entries than the configured limit', async () => {
    const buffer = await buildZipFixture({
      'a.md': 'a',
      'b.md': 'b',
      'c.md': 'c',
    });
    const service = new ZipExtractorService(
      buildConfig({ maxEntryCount: 2 }),
      buildLogger() as never,
    );

    await expect(service.extract(buffer)).rejects.toThrow(
      ArchiveSizeLimitExceededError,
    );
  });

  it('rejects an archive exceeding the configured uncompressed size limit', async () => {
    const buffer = await buildZipFixture({
      'big.md': 'x'.repeat(1000),
    });
    const service = new ZipExtractorService(
      buildConfig({ maxUncompressedBytes: 10 }),
      buildLogger() as never,
    );

    await expect(service.extract(buffer)).rejects.toThrow(
      ArchiveSizeLimitExceededError,
    );
  });

  it('rejects a buffer that is not a valid zip archive', async () => {
    const service = new ZipExtractorService(
      buildConfig({}),
      buildLogger() as never,
    );

    await expect(
      service.extract(Buffer.from('not a zip file')),
    ).rejects.toThrow(ArchiveCorruptError);
  });
});
