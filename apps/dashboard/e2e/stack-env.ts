import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// What the compose stack generated. Read from the file, because Playwright runs in a
// container that gets only a few variables, with the checkout mounted at the same path.
export function stackFile(): Record<string, string> {
  const path = fileURLToPath(new URL('../../../deploy/.env', import.meta.url));
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

function required(file: Record<string, string>, key: string): string {
  const value = file[key] ?? '';
  if (value === '') throw new Error(`deploy/.env has no ${key}. Run scripts/selfhost.sh up.`);
  return value;
}

export function roleUrl(file: Record<string, string>, role: string, passwordKey: string): string {
  const password = encodeURIComponent(required(file, passwordKey));
  const port = file['DREFYN_POSTGRES_PORT'] ?? '55432';
  return `postgres://${role}:${password}@127.0.0.1:${port}/drefyn`;
}

// The settings of one dashboard server, on loopback http with no proxy in front.
export function serverEnv(origin: string): Record<string, string> {
  const file = stackFile();
  return {
    DREFYN_APP_ORIGIN: origin,
    DREFYN_TRUSTED_PROXY_HOPS: '0',
    UV_THREADPOOL_SIZE: '16',
    DREFYN_AUTH_COOKIE_SECURE: 'false',
    DREFYN_AUTH_SECRET: required(file, 'DREFYN_AUTH_SECRET'),
    DREFYN_AUTH_INVITATION_BLOCK_KEY: required(file, 'DREFYN_AUTH_INVITATION_BLOCK_KEY'),
    DREFYN_DATABASE_URL: roleUrl(file, 'drefyn_app', 'DREFYN_APP_PASSWORD'),
    DREFYN_AUTH_DATABASE_URL: roleUrl(file, 'drefyn_auth', 'DREFYN_AUTH_PASSWORD'),
    DREFYN_DATABASE_SSL: 'disable',
    DREFYN_EMAIL_TRANSPORT: 'smtp',
    DREFYN_EMAIL_FROM: 'drefyn@example.dev',
    DREFYN_SMTP_HOST: '127.0.0.1',
    DREFYN_SMTP_PORT: file['DREFYN_MAILPIT_SMTP_PORT'] ?? '51025',
    DREFYN_SMTP_TLS: 'none',
    DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
    DREFYN_HOSTED: 'true',
    DREFYN_DASHBOARD_STATES: 'on',
  };
}
