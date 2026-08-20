import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { GenerationService } from '../generation/generation.service';
import { GenerationResult } from '../generation/generation.types';
import { GenerationProviderError } from '../generation/llm.errors';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { RetrievalController } from './retrieval.controller';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { RetrievalService } from './retrieval.service';

function buildVectorStoreConfig(): VectorStoreConfigService {
  return { domain: 'docker' } as VectorStoreConfigService;
}

function buildEmbeddingConfig(): EmbeddingConfigService {
  return {
    provider: 'fake',
    model: 'fake-model',
    modelVersion: '1',
    dimensions: 4,
  } as EmbeddingConfigService;
}

function buildGenerationResult(): GenerationResult {
  return {
    answer: 'The answer is X [S1].',
    sources: [
      {
        documentId: 'doc1',
        chunkId: 'child1',
        title: 'Install Docker',
        headingPath: 'Install',
        source: 'install.md',
        score: 0.9,
      },
    ],
    metadata: {
      provider: 'fake',
      framework: 'langchain',
      model: 'fake-model',
      retrievedCount: 1,
    },
  };
}

describe('RetrievalController', () => {
  it('throws BadRequestException when text is missing', async () => {
    const retrieve = jest.fn();
    const generate = jest.fn();
    const controller = new RetrievalController(
      { retrieve } as unknown as RetrievalService,
      { generate } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when text is an empty/whitespace string', async () => {
    const controller = new RetrievalController(
      { retrieve: jest.fn() } as unknown as RetrievalService,
      { generate: jest.fn() } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws BadRequestException when text is not a string', async () => {
    const controller = new RetrievalController(
      { retrieve: jest.fn() } as unknown as RetrievalService,
      { generate: jest.fn() } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 42 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws BadRequestException when text exceeds the maximum length', async () => {
    const controller = new RetrievalController(
      { retrieve: jest.fn() } as unknown as RetrievalService,
      { generate: jest.fn() } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(
      controller.query({ text: 'x'.repeat(2001) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('retrieves then generates, returning the GenerationResult as-is', async () => {
    const results = [{ chunkId: 'child1' }];
    const retrieve = jest.fn().mockResolvedValue(results);
    const generationResult = buildGenerationResult();
    const generate = jest.fn().mockResolvedValue(generationResult);
    const controller = new RetrievalController(
      { retrieve } as unknown as RetrievalService,
      { generate } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    const response = await controller.query({
      text: 'how do I install docker?',
    });

    expect(retrieve).toHaveBeenCalledWith(
      { text: 'how do I install docker?', domain: 'docker' },
      'docker__fake_fake_model_4d_v1',
    );
    expect(generate).toHaveBeenCalledWith('how do I install docker?', results);
    expect(response).toEqual(generationResult);
  });

  it('maps RetrievalValidationError from the service to BadRequestException', async () => {
    const retrieve = jest
      .fn()
      .mockRejectedValue(new RetrievalValidationError('bad query'));
    const controller = new RetrievalController(
      { retrieve } as unknown as RetrievalService,
      { generate: jest.fn() } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 'hello' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('maps RetrievalConfigMismatchError from the service to ServiceUnavailableException', async () => {
    const retrieve = jest.fn().mockRejectedValue(
      new RetrievalConfigMismatchError(3, {
        provider: 'fake',
        model: 'fake-model',
        dimensions: 4,
      }),
    );
    const controller = new RetrievalController(
      { retrieve } as unknown as RetrievalService,
      { generate: jest.fn() } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 'hello' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps GenerationProviderError from the service to ServiceUnavailableException', async () => {
    const retrieve = jest.fn().mockResolvedValue([]);
    const generate = jest
      .fn()
      .mockRejectedValue(new GenerationProviderError('boom', 'provider'));
    const controller = new RetrievalController(
      { retrieve } as unknown as RetrievalService,
      { generate } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 'hello' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('lets an unrecognized error type propagate unchanged', async () => {
    const boom = new Error('unexpected');
    const retrieve = jest.fn().mockRejectedValue(boom);
    const controller = new RetrievalController(
      { retrieve } as unknown as RetrievalService,
      { generate: jest.fn() } as unknown as GenerationService,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 'hello' })).rejects.toBe(boom);
  });
});
