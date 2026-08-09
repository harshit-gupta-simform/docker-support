export class ArchiveCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArchiveCorruptError';
  }
}

export class ArchiveSizeLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveSizeLimitExceededError';
  }
}

export class ArchiveEntryPathTraversalError extends Error {
  constructor(public readonly entryName: string) {
    super(`Archive entry resolves outside the extraction root: ${entryName}`);
    this.name = 'ArchiveEntryPathTraversalError';
  }
}

export class IngestionThresholdExceededError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly matchedCount: number,
  ) {
    super(
      `Ingestion aborted: ${failedCount}/${matchedCount} files failed, exceeding the 50% failure threshold`,
    );
    this.name = 'IngestionThresholdExceededError';
  }
}
