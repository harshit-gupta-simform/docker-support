import { resolve, sep } from 'node:path';
import { ArchiveEntryPathTraversalError } from './ingestion.errors';

const VIRTUAL_EXTRACTION_ROOT = resolve('/__ingestion_extraction_root__');

export function assertSafeEntryName(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');

  if (normalized.startsWith('/') || normalized.includes('\0')) {
    throw new ArchiveEntryPathTraversalError(entryName);
  }

  const resolved = resolve(VIRTUAL_EXTRACTION_ROOT, normalized);
  const isWithinRoot =
    resolved === VIRTUAL_EXTRACTION_ROOT ||
    resolved.startsWith(VIRTUAL_EXTRACTION_ROOT + sep);

  if (!isWithinRoot) {
    throw new ArchiveEntryPathTraversalError(entryName);
  }
}
