import {
  ArchiveCorruptError,
  ArchiveEntryPathTraversalError,
  ArchiveSizeLimitExceededError,
  IngestionThresholdExceededError,
} from './ingestion.errors';

describe('ingestion errors', () => {
  it('ArchiveCorruptError carries name, message, and cause', () => {
    const cause = new Error('zlib failure');
    const err = new ArchiveCorruptError('bad zip', { cause });

    expect(err.name).toBe('ArchiveCorruptError');
    expect(err.message).toBe('bad zip');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('ArchiveSizeLimitExceededError carries name and message', () => {
    const err = new ArchiveSizeLimitExceededError('too big');

    expect(err.name).toBe('ArchiveSizeLimitExceededError');
    expect(err.message).toBe('too big');
  });

  it('ArchiveEntryPathTraversalError formats the entry name into its message', () => {
    const err = new ArchiveEntryPathTraversalError('../../etc/passwd');

    expect(err.name).toBe('ArchiveEntryPathTraversalError');
    expect(err.entryName).toBe('../../etc/passwd');
    expect(err.message).toContain('../../etc/passwd');
  });

  it('IngestionThresholdExceededError reports failed/matched counts in its message', () => {
    const err = new IngestionThresholdExceededError(6, 10);

    expect(err.name).toBe('IngestionThresholdExceededError');
    expect(err.failedCount).toBe(6);
    expect(err.matchedCount).toBe(10);
    expect(err.message).toBe(
      'Ingestion aborted: 6/10 files failed, exceeding the 50% failure threshold',
    );
  });
});
