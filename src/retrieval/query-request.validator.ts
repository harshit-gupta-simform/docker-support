const MAX_QUERY_LENGTH = 2000;

export function validateQueryText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new Error('"text" is required and must be a string');
  }
  if (text.length > MAX_QUERY_LENGTH) {
    throw new Error(`"text" must not exceed ${MAX_QUERY_LENGTH} characters`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('"text" must not be empty or whitespace-only');
  }
  return trimmed;
}
