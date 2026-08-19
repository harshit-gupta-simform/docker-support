import { deriveCollectionName } from './vector-store-collection-name.util';

describe('deriveCollectionName', () => {
  it('joins domain/provider/model/dimensions/version into a sanitized name', () => {
    expect(
      deriveCollectionName({
        domain: 'docker',
        provider: 'google',
        model: 'gemini-embedding-2',
        dimensions: 768,
        modelVersion: '1',
      }),
    ).toBe('docker__google_gemini_embedding_2_768d_v1');
  });

  it('sanitizes uppercase and non-alphanumeric characters', () => {
    expect(
      deriveCollectionName({
        domain: 'Docker',
        provider: 'Fake',
        model: 'Fake Model!',
        dimensions: 4,
        modelVersion: '1',
      }),
    ).toBe('docker__fake_fake_model__4d_v1');
  });
});
