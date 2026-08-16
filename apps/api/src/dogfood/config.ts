import { resolve } from 'node:path';

export const APP_LOGIN = 'kf_api_dev';
export const APP_PASSWORD = 'dev-only-not-a-secret';

export function sourceDirectory(): string {
  const flag = process.argv.indexOf('--source-dir');
  const argument = flag === -1 ? undefined : process.argv[flag + 1];
  const source = argument ?? process.env['KF_CONSTITUTION_DIR'];
  if (source === undefined || source.trim() === '') {
    throw new Error('Pass --source-dir or set KF_CONSTITUTION_DIR.');
  }
  return resolve(source);
}

export function requiredOwnerUrl(): string {
  if (process.env['NODE_ENV'] !== 'development') {
    throw new Error('Dogfood loader runs only with NODE_ENV=development.');
  }
  const value = process.env['DATABASE_OWNER_URL'];
  if (value === undefined || value.trim() === '') {
    throw new Error('DATABASE_OWNER_URL is required for local bootstrap.');
  }
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('DATABASE_OWNER_URL must target local PostgreSQL.');
  }
  return value;
}
