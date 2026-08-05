import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults when optional variables are absent', () => {
    const result = validateEnv({});

    expect(result).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces PORT from a string to a number', () => {
    const result = validateEnv({ PORT: '4000' });

    expect(result.PORT).toBe(4000);
  });

  it('accepts a fully specified valid configuration', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'debug',
    });

    expect(result).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'debug',
    });
  });

  it('throws with a descriptive message for an invalid NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('throws for a non-numeric PORT', () => {
    expect(() => validateEnv({ PORT: 'not-a-number' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
