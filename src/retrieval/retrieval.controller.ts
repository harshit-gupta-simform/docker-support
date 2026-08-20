import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { deriveCollectionName } from '../vector-store/vector-store-collection-name.util';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { RetrievalService } from './retrieval.service';
import { RetrievalResult } from './retrieval.types';

interface QueryRequestBody {
  text?: unknown;
}

interface QueryResponseBody {
  collection: string;
  count: number;
  results: RetrievalResult[];
}

@Controller()
export class RetrievalController {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly vectorStoreConfig: VectorStoreConfigService,
    private readonly embeddingConfig: EmbeddingConfigService,
  ) {}

  @Post('query')
  @HttpCode(HttpStatus.OK)
  async query(@Body() body: QueryRequestBody): Promise<QueryResponseBody> {
    if (typeof body?.text !== 'string' || body.text.trim().length === 0) {
      throw new BadRequestException(
        '"text" is required and must be a non-empty string',
      );
    }

    const collection = deriveCollectionName({
      domain: this.vectorStoreConfig.domain,
      provider: this.embeddingConfig.provider,
      model: this.embeddingConfig.model,
      dimensions: this.embeddingConfig.dimensions,
      modelVersion: this.embeddingConfig.modelVersion,
    });

    try {
      const results = await this.retrieval.retrieve(
        { text: body.text, domain: this.vectorStoreConfig.domain },
        collection,
      );
      return { collection, count: results.length, results };
    } catch (err) {
      if (err instanceof RetrievalValidationError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof RetrievalConfigMismatchError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }
}
