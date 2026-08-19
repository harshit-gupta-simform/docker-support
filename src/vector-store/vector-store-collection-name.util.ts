function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export function deriveCollectionName(config: {
  domain: string;
  provider: string;
  model: string;
  dimensions: number;
  modelVersion: string;
}): string {
  return sanitize(
    `${config.domain}__${config.provider}_${config.model}_${config.dimensions}d_v${config.modelVersion}`,
  );
}
