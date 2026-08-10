export class EmptyDocumentError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} has no content to chunk (empty bodyText)`);
    this.name = 'EmptyDocumentError';
  }
}

export class UnbalancedHeadingStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedHeadingStructureError';
  }
}
