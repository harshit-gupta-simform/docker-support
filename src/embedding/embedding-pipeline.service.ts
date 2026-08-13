import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import pLimit from 'p-limit';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { EmbeddingConfigService } from './embedding-config.service';
import {
  EMBEDDING_PROVIDER_PORT,
  type EmbeddingProviderPort,
} from './embedding-provider.port';
import { buildEmbeddingInput } from './embedding-input-builder.util';
import { deriveEmbeddingId } from './embedding-id.util';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingThresholdExceededError } from './embedding.errors';
import {
  EmbeddingFailure,
  EmbeddingInput,
  EmbeddingRunResult,
} from './embedding.types';

// EMBEDDING_BATCH_SIZE alone caps how many chunks go into one provider
// request, but not the SUMMED token count of a batch. With the default
// EMBEDDING_CHUNK_TYPES=child this is safe in practice (children are small),
// but EMBEDDING_CHUNK_TYPES=parent,child is a valid, schema-supported
// configuration where 'parent' chunks are whole, uncapped sections — a
// batch of `batchSize` such chunks could exceed a real provider's
// per-request token ceiling, causing a 400 (whole-batch failure). This
// budget is a conservative multiple of the per-input truncation ceiling
// (EMBEDDING_INPUT_MAX_TOKENS), decoupled from batchSize so it can actually
// bind before the count limit for a run of large inputs.
const BATCH_TOKEN_BUDGET_MULTIPLIER = 8;

// Greedily fills batches up to whichever limit — chunk count or summed
// token budget — is hit first, closing the current batch early (even if
// count still has room) rather than exceeding the token budget. A lone
// input that alone exceeds the token budget still gets its own
// single-item batch (there is nothing smaller we could do with it).
export function batchEligibleInputs(
  items: EmbeddingInput[],
  maxCount: number,
  maxTokenBudget: number,
): EmbeddingInput[][] {
  const batches: EmbeddingInput[][] = [];
  let current: EmbeddingInput[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const wouldExceedCount = current.length >= maxCount;
    const wouldExceedTokenBudget =
      current.length > 0 && currentTokens + item.tokenCount > maxTokenBudget;

    if (wouldExceedCount || wouldExceedTokenBudget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(item);
    currentTokens += item.tokenCount;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

@Injectable()
export class EmbeddingPipelineService {
  constructor(
    private readonly config: EmbeddingConfigService,
    private readonly outputStore: EmbeddingOutputStoreService,
    private readonly batchProcessor: EmbeddingBatchProcessorService,
    @Inject(EMBEDDING_PROVIDER_PORT)
    private readonly provider: EmbeddingProviderPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmbeddingPipelineService.name);
  }

  async run(chunksDir: string): Promise<EmbeddingRunResult> {
    const startedAt = Date.now();
    const jobId = randomUUID();

    this.logger.info(
      {
        jobId,
        provider: this.provider.metadata.provider,
        model: this.provider.metadata.model,
        chunksDir,
      },
      'Embedding run started',
    );

    const existingIds = await this.outputStore.loadExistingEmbeddingIds();

    let totalChunksScanned = 0;
    let skippedByType = 0;
    let skippedEmpty = 0;
    let alreadyEmbedded = 0;
    const eligibleInputs: EmbeddingInput[] = [];

    const files = (await readdir(chunksDir)).filter((file) =>
      file.endsWith('.chunks.json'),
    );
    for (const file of files) {
      const raw = await readFile(join(chunksDir, file), 'utf-8');
      const chunks = JSON.parse(raw) as Chunk[];

      for (const chunk of chunks) {
        totalChunksScanned += 1;

        if (!this.config.chunkTypes.includes(chunk.metadata.chunkType)) {
          skippedByType += 1;
          continue;
        }

        const input = buildEmbeddingInput(chunk, {
          includeHeadingContext: this.config.includeHeadingContext,
          maxInputTokens: this.config.inputMaxTokens,
        });
        if (!input) {
          skippedEmpty += 1;
          this.logger.debug(
            { chunkId: chunk.chunkId },
            'Skipping empty chunk — nothing to embed',
          );
          continue;
        }

        const embeddingId = deriveEmbeddingId(
          input.chunkId,
          input.contentHash,
          this.provider.metadata,
        );
        if (existingIds.has(embeddingId)) {
          alreadyEmbedded += 1;
          continue;
        }

        eligibleInputs.push(input);
      }
    }

    let skippedByMaxChunksCap = 0;
    let cappedInputs = eligibleInputs;
    if (
      this.config.maxChunksPerRun > 0 &&
      eligibleInputs.length > this.config.maxChunksPerRun
    ) {
      cappedInputs = eligibleInputs.slice(0, this.config.maxChunksPerRun);
      skippedByMaxChunksCap = eligibleInputs.length - cappedInputs.length;
      this.logger.warn(
        {
          jobId,
          maxChunksPerRun: this.config.maxChunksPerRun,
          eligibleCount: eligibleInputs.length,
          skippedByMaxChunksCap,
        },
        'Eligible chunk count exceeds EMBEDDING_MAX_CHUNKS_PER_RUN — truncating this run',
      );
    }

    const batches = batchEligibleInputs(
      cappedInputs,
      this.config.batchSize,
      this.config.inputMaxTokens * BATCH_TOKEN_BUDGET_MULTIPLIER,
    );
    const limit = pLimit(this.config.maxConcurrentBatches);
    let succeededCount = 0;
    const failures: EmbeddingFailure[] = [];

    await Promise.all(
      batches.map((batchInputs, index) =>
        limit(async () => {
          const batchId = `${jobId}-${index}`;
          const outcome = await this.batchProcessor.processBatch(
            batchId,
            batchInputs,
          );

          for (const record of outcome.succeeded) {
            await this.outputStore.append(record);
          }
          succeededCount += outcome.succeeded.length;
          failures.push(...outcome.failed);

          this.logger.info(
            {
              jobId,
              batchId,
              chunkCount: batchInputs.length,
              succeeded: outcome.succeeded.length,
              failed: outcome.failed.length,
              provider: this.provider.metadata.provider,
              model: this.provider.metadata.model,
            },
            'Embedding batch completed',
          );
        }),
      ),
    );

    const attempted = cappedInputs.length;
    if (
      attempted > 0 &&
      failures.length / attempted > this.config.failureThreshold
    ) {
      throw new EmbeddingThresholdExceededError(failures.length, attempted);
    }

    const result: EmbeddingRunResult = {
      jobId,
      totalChunksScanned,
      skippedByType,
      skippedEmpty,
      alreadyEmbedded,
      skippedByMaxChunksCap,
      attempted,
      succeeded: succeededCount,
      failed: failures.length,
      failures,
      totalBatches: batches.length,
      provider: this.provider.metadata.provider,
      model: this.provider.metadata.model,
      outputPath: this.outputStore.outputFilePath(),
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(
      { ...result, failures: undefined },
      'Embedding run completed',
    );
    return result;
  }
}
