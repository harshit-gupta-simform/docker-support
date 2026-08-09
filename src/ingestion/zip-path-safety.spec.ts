import { ArchiveEntryPathTraversalError } from './ingestion.errors';
import { assertSafeEntryName } from './zip-path-safety';

describe('assertSafeEntryName', () => {
  it('allows a normal relative entry name', () => {
    expect(() => assertSafeEntryName('docs/intro.md')).not.toThrow();
  });

  it('allows a top-level file', () => {
    expect(() => assertSafeEntryName('readme.md')).not.toThrow();
  });

  it('rejects an entry that escapes the root via ../', () => {
    expect(() => assertSafeEntryName('../outside.md')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects an entry that escapes the root via a nested ../..', () => {
    expect(() => assertSafeEntryName('a/../../outside.md')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects an absolute path entry', () => {
    expect(() => assertSafeEntryName('/etc/passwd')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects a backslash-based traversal attempt', () => {
    expect(() => assertSafeEntryName('..\\..\\outside.md')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects an entry name containing a null byte', () => {
    expect(() => assertSafeEntryName('docs/intro.md\0.png')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });
});
