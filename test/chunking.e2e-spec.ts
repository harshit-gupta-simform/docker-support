import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { ChunkingPipelineService } from '../src/chunking/chunking-pipeline.service';
import { ChunkingModule } from '../src/chunking/chunking.module';
import { Chunk } from '../src/chunking/chunking.types';
import { validateEnv } from '../src/config/env.validation';
import { StructuredDocument } from '../src/ingestion/ingestion.types';

describe('Chunking (e2e)', () => {
  let outputDir: string;
  const previousOutputDir = process.env['CHUNKING_OUTPUT_DIR'];

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'chunking-e2e-'));
    process.env['CHUNKING_OUTPUT_DIR'] = outputDir;
  });

  afterAll(async () => {
    if (previousOutputDir === undefined) {
      delete process.env['CHUNKING_OUTPUT_DIR'];
    } else {
      process.env['CHUNKING_OUTPUT_DIR'] = previousOutputDir;
    }
    await rm(outputDir, { recursive: true, force: true });
  });

  it('chunks a real fixture document end-to-end with no truncated code fences or table rows', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnv,
          cache: false,
        }),
        LoggerModule.forRoot(),
        ChunkingModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const pipeline = app.get(ChunkingPipelineService);
    const fixtureRaw = await readFile(
      join(__dirname, 'fixtures', 'chunking', 'docker-install-guide.json'),
      'utf-8',
    );
    const document = JSON.parse(fixtureRaw) as StructuredDocument;

    const result = await pipeline.chunk(document);

    expect(result.chunks.length).toBeGreaterThan(0);

    for (const chunk of result.chunks) {
      const fenceMarkers = (chunk.text.match(/```/g) ?? []).length;
      expect(fenceMarkers % 2).toBe(0);
    }

    const codeChunk = result.chunks.find((c) =>
      c.text.includes('get-docker.sh'),
    );
    expect(codeChunk?.text).toContain('curl -fsSL https://get.docker.com');
    expect(codeChunk?.text).toContain('sudo sh get-docker.sh');

    const nonRootChunks = result.chunks.filter(
      (c: Chunk) => c.metadata.chunkType === 'child',
    );
    expect(nonRootChunks.every((c) => c.metadata.headingPath.length > 0)).toBe(
      true,
    );

    const tableChunk = result.chunks.find((c) => c.text.includes('| Ubuntu |'));
    expect(tableChunk?.text).toContain('| Platform | Supported |');

    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toContain('fixture-doc-1.chunks.json');

    await app.close();
  });
});
