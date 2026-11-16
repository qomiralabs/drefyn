import { parseAuthConfig, type AuthConfig } from '@drefyn/auth';

let config: AuthConfig | undefined;

export function authConfig(): AuthConfig {
  config ??= parseAuthConfig(process.env);
  return config;
}

export function sessionCookieName(): string {
  return authConfig().cookies.session;
}
