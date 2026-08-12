import { EmbeddingResponseValidationError } from './embedding.errors';
import { validateProviderResponse } from './embedding-response-validator.util';

const requestItems = [
  { id: 'a', text: 'hello' },
  { id: 'b', text: 'world' },
];

function validResponse() {
  return [
    { id: 'a', vector: [0.1, 0.2] },
    { id: 'b', vector: [0.3, 0.4] },
  ];
}

describe('validateProviderResponse', () => {
  it('does not throw for a valid, correctly-ordered, correctly-dimensioned response', () => {
    expect(() =>
      validateProviderResponse(requestItems, validResponse(), 2),
    ).not.toThrow();
  });

  it('throws when the response has fewer items than requested', () => {
    expect(() =>
      validateProviderResponse(requestItems, [validResponse()[0]!], 2),
    ).toThrow(EmbeddingResponseValidationError);
  });

  it('throws when the response has more items than requested', () => {
    expect(() =>
      validateProviderResponse(
        requestItems,
        [...validResponse(), { id: 'c', vector: [0.5, 0.6] }],
        2,
      ),
    ).toThrow(EmbeddingResponseValidationError);
  });

  it('throws when response ordering does not match request ordering', () => {
    const reordered = [validResponse()[1]!, validResponse()[0]!];

    expect(() => validateProviderResponse(requestItems, reordered, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector is missing (empty array)', () => {
    const response = [{ id: 'a', vector: [] }, validResponse()[1]!];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector has the wrong dimension', () => {
    const response = [
      { id: 'a', vector: [0.1, 0.2, 0.3] },
      validResponse()[1]!,
    ];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector contains a non-finite value', () => {
    const response = [
      { id: 'a', vector: [0.1, Infinity] },
      validResponse()[1]!,
    ];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector contains a NaN value', () => {
    const response = [
      { id: 'a', vector: [0.1, Number.NaN] },
      validResponse()[1]!,
    ];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });
});
