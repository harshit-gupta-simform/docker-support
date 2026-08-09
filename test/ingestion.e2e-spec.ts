import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../src/config/env.validation';
import { IngestionPipelineService } from '../src/ingestion/ingestion-pipeline.service';
import { IngestionModule } from '../src/ingestion/ingestion.module';
import { StructuredDocument } from '../src/ingestion/ingestion.types';

describe('Ingestion (e2e)', () => {
  let outputDir: string;
  const previousOutputDir = process.env['INGESTION_OUTPUT_DIR'];

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'ingestion-e2e-'));
    process.env['INGESTION_OUTPUT_DIR'] = outputDir;
  });

  afterAll(async () => {
    if (previousOutputDir === undefined) {
      delete process.env['INGESTION_OUTPUT_DIR'];
    } else {
      process.env['INGESTION_OUTPUT_DIR'] = previousOutputDir;
    }
    await rm(outputDir, { recursive: true, force: true });
  });

  it('ingests a real ZIP fixture end-to-end into StructuredDocument JSON files', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnv,
          cache: false,
        }),
        LoggerModule.forRoot(),
        IngestionModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const pipeline = app.get(IngestionPipelineService);
    const archiveBuffer = readFileSync(
      join(__dirname, 'fixtures', 'ingestion', 'sample-docs.zip'),
    );

    const result = await pipeline.run(archiveBuffer);

    expect(result.matchedEntries).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toHaveLength(2);

    const documents = await Promise.all(
      outputFiles.map(async (file) => {
        const contents = await readFile(join(outputDir, file), 'utf-8');
        return JSON.parse(contents) as StructuredDocument;
      }),
    );

    const introDoc = documents.find(
      (doc) => doc.metadata.sourcePath === 'intro.md',
    );
    expect(introDoc).toBeDefined();
    expect(introDoc?.metadata.title).toBe('Introduction');
    expect(introDoc?.metadata.language).toBe('en');
    expect(introDoc?.codeBlocks).toEqual([
      { language: 'bash', content: 'docker --version\n', position: 0 },
    ]);

    const setupDoc = documents.find(
      (doc) => doc.metadata.sourcePath === 'guide/setup.md',
    );
    expect(setupDoc).toBeDefined();
    expect(setupDoc?.headings[0]?.text).toBe('Setup');
    expect(setupDoc?.headings[0]?.children).toHaveLength(2);

    await app.close();
  });
});
