/**
 * Fail fast with a readable message when required environment variables are missing.
 * See `.env.example` for the full list.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const read = (key: string) => (typeof config[key] === 'string' ? (config[key] as string).trim() : '');

  const databaseUrl = read('DATABASE_URL');
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required (e.g. mongodb://127.0.0.1:27017/hcm_lite)');
  } else if (!/^mongodb(\+srv)?:\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a MongoDB connection string (mongodb:// or mongodb+srv://)');
  }

  if (read('JWT_SECRET').length < 16) {
    errors.push('JWT_SECRET is required and must be at least 16 characters long');
  }

  const port = read('PORT');
  if (port && !(Number(port) > 0 && Number(port) < 65536)) {
    errors.push('PORT must be a valid port number');
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}\nCopy .env.example to .env and fill it in.`);
  }
  return config;
}
