import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { RetrievalController } from './retrieval.controller';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { RetrievalService } from './retrieval.service';
import { RetrievalResult } from './retrieval.types';

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

function buildResult(
  overrides: Partial<RetrievalResult> = {},
): RetrievalResult {
  return {
    chunkId: 'child1',
    documentId: 'doc1',
    parentChunkId: null,
    chunkType: 'child',
    score: 0.9,
    text: 'Run docker --version.',
    parentText: null,
    headingPath: 'Install',
    documentTitle: 'Install Docker',
    sourcePath: 'install.md',
    domain: 'docker',
    ...overrides,
  };
}

describe('RetrievalController', () => {
  it('throws BadRequestException when text is missing', async () => {
    const retrieve = jest.fn();
    const retrieval = { retrieve } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when text is an empty/whitespace string', async () => {
    const retrieval = { retrieve: jest.fn() } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws BadRequestException when text is not a string', async () => {
    const retrieval = { retrieve: jest.fn() } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 42 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('calls RetrievalService.retrieve with the derived collection name and domain, returning an envelope', async () => {
    const results = [buildResult()];
    const retrieve = jest.fn().mockResolvedValue(results);
    const retrieval = { retrieve } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
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
    expect(response).toEqual({
      collection: 'docker__fake_fake_model_4d_v1',
      count: 1,
      results,
    });
  });

  it('maps RetrievalValidationError from the service to BadRequestException', async () => {
    const retrieve = jest
      .fn()
      .mockRejectedValue(new RetrievalValidationError('bad query'));
    const retrieval = { retrieve } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
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
    const retrieval = { retrieve } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
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
    const retrieval = { retrieve } as unknown as RetrievalService;
    const controller = new RetrievalController(
      retrieval,
      buildVectorStoreConfig(),
      buildEmbeddingConfig(),
    );

    await expect(controller.query({ text: 'hello' })).rejects.toBe(boom);
  });
});
