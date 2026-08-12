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
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildStore(
    configOverrides: Partial<EmbeddingConfigService> = {},
  ): EmbeddingOutputStoreService {
    const config = {
      outputDir,
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 2,
      ...configOverrides,
    } as EmbeddingConfigService;
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

  it('throws a clear error when the existing output was written with a different provider/model configuration', async () => {
    const store = buildStore();
    await store.append(buildRecord({ embeddingId: 'emb1', provider: 'fake' }));

    const mismatchedStore = buildStore({ provider: 'voyage' });

    await expect(mismatchedStore.loadExistingEmbeddingIds()).rejects.toThrow(
      /provider=fake.*provider=voyage/s,
    );
  });

  it('does not throw when the existing output matches the current provider/model configuration', async () => {
    const store = buildStore();
    await store.append(buildRecord({ embeddingId: 'emb1' }));
    await store.append(buildRecord({ embeddingId: 'emb2' }));

    const ids = await buildStore().loadExistingEmbeddingIds();

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
    const store = buildStore();
    let doWriteCallCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const storeWithPrivate = store as any;

    // Patch the service's doWrite method to track calls and fail once
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const originalDoWrite: (record: EmbeddingRecord) => Promise<void> =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      storeWithPrivate['doWrite'].bind(store);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    storeWithPrivate['doWrite'] = jest.fn(
      (record: EmbeddingRecord): Promise<void> => {
        doWriteCallCount++;
        if (doWriteCallCount === 1) {
          return Promise.reject(
            new Error('Simulated transient write failure (e.g., ENOSPC)'),
          );
        }

        return originalDoWrite(record);
      },
    );

    // First append: should fail
    const firstAppend = store.append(buildRecord({ embeddingId: 'emb1' }));
    await expect(firstAppend).rejects.toThrow(
      'Simulated transient write failure',
    );

    // Verify doWrite was called once for the first append
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(storeWithPrivate['doWrite']).toHaveBeenCalledTimes(1);

    // Second append: should succeed
    // With the fix, doWrite will be called again (both fulfill and reject paths call it)
    // With buggy code, doWrite would NOT be called (the queue would short-circuit)
    const secondAppend = store.append(buildRecord({ embeddingId: 'emb2' }));
    await expect(secondAppend).resolves.toBeUndefined();

    // Verify doWrite was called a SECOND time (proving the queue didn't poison)
    // This assertion fails with buggy code because the second .then() short-circuits
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(storeWithPrivate['doWrite']).toHaveBeenCalledTimes(2);

    // Verify the second record was actually written
    const ids = await store.loadExistingEmbeddingIds();
    expect(ids).toEqual(new Set(['emb2']));
  });
});
