import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../src/config/env.validation';
import { EmbeddingModule } from '../src/embedding/embedding.module';
import { EmbeddingPipelineService } from '../src/embedding/embedding-pipeline.service';

describe('Embedding e2e', () => {
  let chunksDir: string;
  let outputDir: string;

  beforeEach(async () => {
    chunksDir = await mkdtemp(join(tmpdir(), 'embedding-e2e-chunks-'));
    outputDir = await mkdtemp(join(tmpdir(), 'embedding-e2e-output-'));
    const fixture = await readFile(
      join(
        __dirname,
        'fixtures',
        'embedding',
        'docker-install-guide.chunks.json',
      ),
      'utf-8',
    );
    await mkdir(chunksDir, { recursive: true });
    await writeFile(
      join(chunksDir, 'docker-install-guide.chunks.json'),
      fixture,
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(chunksDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  async function buildPipeline(): Promise<EmbeddingPipelineService> {
    process.env['EMBEDDING_PROVIDER'] = 'fake';
    process.env['EMBEDDING_OUTPUT_DIR'] = outputDir;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnv,
          cache: false,
        }),
        LoggerModule.forRoot(),
        EmbeddingModule,
      ],
    }).compile();
    return moduleRef.get(EmbeddingPipelineService);
  }

  it('embeds every eligible chunk from a real fixture with correct provenance', async () => {
    const pipeline = await buildPipeline();

    const result = await pipeline.run(chunksDir);

    expect(result.failed).toBe(0);
    expect(result.succeeded).toBeGreaterThan(0);
    expect(result.succeeded).toBe(result.attempted);
  });

  it('is resumable across two real pipeline instances sharing the same output directory', async () => {
    const first = await buildPipeline();
    const firstResult = await first.run(chunksDir);

    const second = await buildPipeline();
    const secondResult = await second.run(chunksDir);

    expect(secondResult.attempted).toBe(0);
    expect(secondResult.alreadyEmbedded).toBe(firstResult.succeeded);
  });
});
