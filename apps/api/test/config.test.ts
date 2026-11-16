import { describe, expect, it } from 'vitest';
import { ApiConfigError, parseApiConfig } from '../src/config.ts';

function keyOf(env: Record<string, string>): string {
  try {
    parseApiConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigError) return error.key;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('parseApiConfig', () => {
  it('uses the defaults on an empty env', () => {
    expect(parseApiConfig({})).toEqual({
      port: 3100,
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1:3100',
      maxBodyBytes: 1_048_576,
      hops: 0,
      viewerHeader: false,
    });
  });

  // Compose passes an unset variable as an empty string.
  it('reads empty values as unset', () => {
    expect(
      parseApiConfig({
        DREFYN_API_PORT: '',
        DREFYN_API_HOST: '',
        DREFYN_API_PUBLIC_URL: '',
        DREFYN_TRUSTED_PROXY_HOPS: '',
        DREFYN_CLIENT_IP_HEADER: '',
      }).port,
    ).toBe(3100);
  });

  it('reads every setting', () => {
    expect(
      parseApiConfig({
        DREFYN_API_PORT: '8080',
        DREFYN_API_HOST: '0.0.0.0',
        DREFYN_API_PUBLIC_URL: 'https://api.example.com',
        DREFYN_API_MAX_BODY_BYTES: '2048',
        DREFYN_TRUSTED_PROXY_HOPS: '2',
        DREFYN_CLIENT_IP_HEADER: 'cloudfront-viewer-address',
      }),
    ).toEqual({
      port: 8080,
      host: '0.0.0.0',
      publicUrl: 'https://api.example.com',
      maxBodyBytes: 2048,
      hops: 2,
      viewerHeader: true,
    });
  });

  it('defaults the public URL to the chosen port', () => {
    expect(parseApiConfig({ DREFYN_API_PORT: '4000' }).publicUrl).toBe('http://127.0.0.1:4000');
  });

  // openapi.json carries it, so production must name the real one.
  it('needs the public URL in production', () => {
    expect(keyOf({ NODE_ENV: 'production' })).toBe('DREFYN_API_PUBLIC_URL');
    expect(
      parseApiConfig({ NODE_ENV: 'production', DREFYN_API_PUBLIC_URL: 'https://api.example.com/' })
        .publicUrl,
    ).toBe('https://api.example.com');
  });

  it.each([
    ['DREFYN_API_PORT', '65536'],
    ['DREFYN_API_PORT', '-1'],
    ['DREFYN_API_PORT', '1e3'],
    ['DREFYN_API_PORT', ' 80'],
    ['DREFYN_API_HOST', 'two words'],
    ['DREFYN_API_PUBLIC_URL', 'ftp://api.example.com'],
    ['DREFYN_API_PUBLIC_URL', 'https://user:pw@api.example.com'],
    ['DREFYN_API_PUBLIC_URL', 'https://api.example.com/v1'],
    ['DREFYN_API_PUBLIC_URL', 'https://api.example.com/?a=1'],
    ['DREFYN_API_PUBLIC_URL', 'https://api.example.com/#x'],
    ['DREFYN_API_PUBLIC_URL', 'not a url'],
    ['DREFYN_API_MAX_BODY_BYTES', '0'],
    ['DREFYN_API_MAX_BODY_BYTES', '67108865'],
    ['DREFYN_API_MAX_BODY_BYTES', '1.5'],
    ['DREFYN_TRUSTED_PROXY_HOPS', '11'],
    ['DREFYN_TRUSTED_PROXY_HOPS', 'one'],
    ['DREFYN_CLIENT_IP_HEADER', 'x-real-ip'],
  ])('refuses %s=%s, naming the key', (key, value) => {
    expect(keyOf({ [key]: value })).toBe(key);
  });

  // A loopback origin has nothing in front of it, so a forwarded address is the client's claim.
  it('refuses proxy hops for a loopback public URL', () => {
    expect(keyOf({ DREFYN_TRUSTED_PROXY_HOPS: '1' })).toBe('DREFYN_TRUSTED_PROXY_HOPS');
    expect(
      keyOf({ DREFYN_TRUSTED_PROXY_HOPS: '1', DREFYN_API_PUBLIC_URL: 'http://localhost:3100' }),
    ).toBe('DREFYN_TRUSTED_PROXY_HOPS');
  });

  it('reads the viewer header only from a trusted hop', () => {
    expect(keyOf({ DREFYN_CLIENT_IP_HEADER: 'cloudfront-viewer-address' })).toBe(
      'DREFYN_CLIENT_IP_HEADER',
    );
  });

  it('never puts a value in the message', () => {
    try {
      parseApiConfig({ DREFYN_API_PUBLIC_URL: 'https://secret-token@x' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-token');
      expect((error as Error).name).toBe('ApiConfigError');
      return;
    }
    throw new Error('expected a refusal');
  });
});
