import { describe, expect, it } from 'vitest';
import * as github from '../src/index.ts';

describe('the package entry', () => {
  it('exposes the broker, the webhook check, the stores and the config', () => {
    expect(Object.keys(github).sort()).toEqual(
      [
        'BROKER_ERROR_CODES',
        'DEFAULT_CALL_TIMEOUT_MS',
        'DEFAULT_GITHUB_API_URL',
        'DELIVERY_RETENTION_MS',
        'GITHUB_FLAG',
        'GitHubConfigError',
        'MINT_PURPOSES',
        'WEBHOOK_MAX_BODY_BYTES',
        'createDeliveryLedger',
        'createGitHubBroker',
        'createInstallationStore',
        'createWebhookReceiver',
        'githubPolicy',
        'noopLogger',
        'parseGitHubAppConfig',
        'parseGitHubWebhookConfig',
        'readWebhookSecret',
        'verifyGitHubWebhook',
      ].sort(),
    );
    expect(() => {
      github.noopLogger.info('x', {});
      github.noopLogger.warn('x', {});
    }).not.toThrow();
  });

  it('gates on the git sync flag and keeps deliveries a month', () => {
    expect(github.GITHUB_FLAG).toBe('docs.git_sync');
    expect(github.MINT_PURPOSES).toEqual(['import', 'sync', 'commit']);
    expect(github.DELIVERY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('builds the guard policy for the configured API only', () => {
    expect(
      github.githubPolicy({
        apiUrl: 'https://api.github.com',
        allowPrivateCidrs: [],
        callTimeoutMs: 15_000,
      }),
    ).toEqual({
      purpose: 'github',
      allowPrivate: false,
      schemes: ['https'],
      ports: [443],
      maxRedirects: 0,
      connectTimeoutMs: 5000,
      totalTimeoutMs: 15_000,
      maxResponseBytes: 8 * 1024 * 1024,
    });
  });
});
