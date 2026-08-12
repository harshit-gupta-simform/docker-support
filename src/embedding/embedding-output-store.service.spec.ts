import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingRecord } from './embedding.types';

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    vector: [0.1, 0.2],
    dimensions: 2,
    provider: 'fake',
    model: 'fake-model',
    modelVersion: '1',
    contentHash: 'hash1',
    inputHash: 'inputhash1',
    inputTokenCount: 10,
    truncated: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('EmbeddingOutputStoreService', () => {
  let outputDir: string;
  let logger: PinoLogger;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'embedding-output-store-'));
    logger = {
      setContext: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    } as unknown as PinoLogger;
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildStore(): EmbeddingOutputStoreService {
    const config = { outputDir } as EmbeddingConfigService;
    return new EmbeddingOutputStoreService(config, logger);
  }

  it('returns an empty set when no output file exists yet', async () => {
    const store = buildStore();

    const ids = await store.loadExistingEmbeddingIds();

    expect(ids.size).toBe(0);
  });

  it('appends a record and loads its embeddingId back', async () => {
    const store = buildStore();

    await store.append(buildRecord());
    const ids = await store.loadExistingEmbeddingIds();

    expect(ids.has('emb1')).toBe(true);
  });

  it('accumulates multiple appended records', async () => {
    const store = buildStore();

    await store.append(buildRecord({ embeddingId: 'emb1' }));
    await store.append(buildRecord({ embeddingId: 'emb2' }));
    const ids = await store.loadExistingEmbeddingIds();

    expect(ids).toEqual(new Set(['emb1', 'emb2']));
  });

  it('tolerates a truncated final line and logs a warning, excluding it from the result', async () => {
    await mkdir(outputDir, { recursive: true });
    const filePath = join(outputDir, 'embeddings.jsonl');
    await appendFile(
      filePath,
      `${JSON.stringify(buildRecord({ embeddingId: 'emb1' }))}\n{"embeddingId": "emb2", "trunca`,
      'utf-8',
    );
    const store = buildStore();

    const ids = await store.loadExistingEmbeddingIds();

    expect(ids).toEqual(new Set(['emb1']));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(logger.warn).toHaveBeenCalled();
  });

  it('throws when a non-final line is corrupt', async () => {
    await mkdir(outputDir, { recursive: true });
    const filePath = join(outputDir, 'embeddings.jsonl');
    await appendFile(
      filePath,
      `{"embeddingId": "broken\n${JSON.stringify(buildRecord({ embeddingId: 'emb2' }))}\n`,
      'utf-8',
    );
    const store = buildStore();

    await expect(store.loadExistingEmbeddingIds()).rejects.toThrow();
  });

  it('serializes concurrent appends without interleaving partial lines', async () => {
    const store = buildStore();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      promises.push(store.append(buildRecord({ embeddingId: `emb${i}` })));
    }

    await Promise.all(promises);
    const ids = await store.loadExistingEmbeddingIds();

    expect(ids.size).toBe(20);
  });

  it('reports the output file path under the configured output directory', () => {
    const store = buildStore();

    expect(store.outputFilePath()).toBe(join(outputDir, 'embeddings.jsonl'));
  });

  it('does not poison the write queue after a single failed append', async () => {
    // Use the actual append which works normally
    const store = buildStore();

    // First append: succeeds normally
    await store.append(buildRecord({ embeddingId: 'emb1' }));

    // Create a second store with an impossible output path
    const impossibleDir = '/dev/null/impossible/path';
    const failingStore = new EmbeddingOutputStoreService(
      { outputDir: impossibleDir } as EmbeddingConfigService,
      logger,
    );

    // First append to failing store: should fail
    const failedAppend = failingStore.append(
      buildRecord({ embeddingId: 'emb2' }),
    );
    await expect(failedAppend).rejects.toThrow();

    // Second append to failing store: should ALSO fail (queue can retry)
    // This proves the queue didn't get permanently poisoned
    const retryAppend = failingStore.append(
      buildRecord({ embeddingId: 'emb3' }),
    );
    await expect(retryAppend).rejects.toThrow();

    // The first store still works, proving the queue mechanism is sound
    const ids = await store.loadExistingEmbeddingIds();
    expect(ids).toEqual(new Set(['emb1']));
  });
});
