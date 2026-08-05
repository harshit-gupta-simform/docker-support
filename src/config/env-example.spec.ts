import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema } from './env.validation';

function parseEnvExampleKeys(): string[] {
  const contents = readFileSync(
    join(__dirname, '..', '..', '.env.example'),
    'utf-8',
  );

  const keys: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const [key] = line.split('=');
    if (key) {
      keys.push(key);
    }
  }

  return keys;
}

describe('.env.example', () => {
  it('declares exactly the same keys as the env schema', () => {
    const exampleKeys = parseEnvExampleKeys().sort();
    const schemaKeys = Object.keys(envSchema.shape).sort();

    expect(exampleKeys).toEqual(schemaKeys);
  });
});
