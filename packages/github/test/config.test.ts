import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_GITHUB_API_URL,
  GitHubConfigError,
  parseGitHubAppConfig,
  parseGitHubWebhookConfig,
} from '../src/index.ts';

const base = {
  DREFYN_GITHUB_APP_ID: '123456',
  DREFYN_GITHUB_PRIVATE_KEY_FILE: '/run/secrets/github-app.pem',
};

const refusal = (env: Record<string, string>) => {
  try {
    parseGitHubAppConfig(env);
  } catch (error) {
    return error;
  }
  return null;
};

describe('parseGitHubAppConfig', () => {
  it('reads the App with the public API and no private ranges by default', () => {
    expect(parseGitHubAppConfig(base)).toEqual({
      appId: 123456,
      privateKeyFile: '/run/secrets/github-app.pem',
      apiUrl: DEFAULT_GITHUB_API_URL,
      allowPrivateCidrs: [],
      callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    });
    expect(DEFAULT_GITHUB_API_URL).toBe('https://api.github.com');
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(15_000);
  });

  it('takes a GitHub Enterprise Server API with its path and a private range', () => {
    const config = parseGitHubAppConfig({
      ...base,
      DREFYN_GITHUB_API_URL: 'https://github.internal.example:8443/api/v3/',
      DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS: '10.20.0.0/16, 10.30.0.0/24',
      DREFYN_GITHUB_CALL_TIMEOUT_MS: '5000',
    });
    expect(config.apiUrl).toBe('https://github.internal.example:8443/api/v3');
    expect(config.allowPrivateCidrs).toEqual(['10.20.0.0/16', '10.30.0.0/24']);
    expect(config.callTimeoutMs).toBe(5000);
  });

  it('treats empty values as unset, as compose passes them', () => {
    expect(
      parseGitHubAppConfig({
        ...base,
        DREFYN_GITHUB_API_URL: '',
        DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS: '',
      }).apiUrl,
    ).toBe(DEFAULT_GITHUB_API_URL);
  });

  it.each([
    ['DREFYN_GITHUB_APP_ID', { DREFYN_GITHUB_APP_ID: '' }],
    ['DREFYN_GITHUB_APP_ID', { DREFYN_GITHUB_APP_ID: '12a' }],
    ['DREFYN_GITHUB_APP_ID', { DREFYN_GITHUB_APP_ID: '0' }],
    ['DREFYN_GITHUB_APP_ID', { DREFYN_GITHUB_APP_ID: '99999999999999999' }],
    ['DREFYN_GITHUB_PRIVATE_KEY_FILE', { DREFYN_GITHUB_PRIVATE_KEY_FILE: '' }],
    ['DREFYN_GITHUB_PRIVATE_KEY_FILE', { DREFYN_GITHUB_PRIVATE_KEY_FILE: 'keys/app.pem' }],
    ['DREFYN_GITHUB_API_URL', { DREFYN_GITHUB_API_URL: 'http://api.github.com' }],
    ['DREFYN_GITHUB_API_URL', { DREFYN_GITHUB_API_URL: 'https://user:pw@api.github.com' }],
    ['DREFYN_GITHUB_API_URL', { DREFYN_GITHUB_API_URL: 'https://api.github.com/?x=1' }],
    ['DREFYN_GITHUB_API_URL', { DREFYN_GITHUB_API_URL: 'https://api.github.com/#x' }],
    ['DREFYN_GITHUB_API_URL', { DREFYN_GITHUB_API_URL: 'not a url' }],
    ['DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS', { DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS: '10.0.0.0' }],
    ['DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS', { DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS: '10.0.0.0/33' }],
    ['DREFYN_GITHUB_CALL_TIMEOUT_MS', { DREFYN_GITHUB_CALL_TIMEOUT_MS: '999' }],
    ['DREFYN_GITHUB_CALL_TIMEOUT_MS', { DREFYN_GITHUB_CALL_TIMEOUT_MS: '60001' }],
    ['DREFYN_GITHUB_CALL_TIMEOUT_MS', { DREFYN_GITHUB_CALL_TIMEOUT_MS: '1e4' }],
  ])('refuses a bad %s and never repeats the value', (key, change) => {
    const error = refusal({ ...base, ...change });
    expect(error).toBeInstanceOf(GitHubConfigError);
    const failure = error as GitHubConfigError;
    expect(failure.key).toBe(key);
    const value = Object.values(change)[0] ?? '';
    if (value.length > 3) expect(failure.message).not.toContain(value);
  });
});

describe('parseGitHubWebhookConfig', () => {
  it('is null when no secret file is set, so the route is never mounted', () => {
    expect(parseGitHubWebhookConfig({})).toBeNull();
    expect(parseGitHubWebhookConfig({ DREFYN_GITHUB_WEBHOOK_SECRET_FILE: '' })).toBeNull();
  });

  it('reads an absolute secret file path', () => {
    expect(
      parseGitHubWebhookConfig({ DREFYN_GITHUB_WEBHOOK_SECRET_FILE: '/run/secrets/hook' }),
    ).toEqual({ secretFile: '/run/secrets/hook' });
  });

  it('refuses a relative path', () => {
    expect(() => parseGitHubWebhookConfig({ DREFYN_GITHUB_WEBHOOK_SECRET_FILE: 'hook' })).toThrow(
      GitHubConfigError,
    );
  });
});
