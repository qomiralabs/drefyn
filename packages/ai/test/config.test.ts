import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  loadModelConfig,
  ModelConfigError,
  type ModelConfig,
} from '../src/index.ts';
import { KEY } from './support/harness.ts';

const readKey = (path: string) =>
  path === '/run/secrets/model-key'
    ? Promise.resolve(`${KEY}\n`)
    : Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));

const load = (env: Record<string, string | undefined>) => loadModelConfig(env, readKey);

async function failure(env: Record<string, string | undefined>) {
  const thrown = await load(env).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(ModelConfigError);
  return thrown as ModelConfigError;
}

const plain = (config: ModelConfig) =>
  config.kind === 'none'
    ? config
    : { ...config, key: config.key === undefined ? undefined : config.key.reveal() };

describe('loadModelConfig', () => {
  it('is off when nothing is set, so AI features stay off and labelled', async () => {
    expect(await load({})).toEqual({ kind: 'none' });
    expect(await load({ DREFYN_MODEL_PROVIDER: '' })).toEqual({ kind: 'none' });
  });

  it('reads the default hosted model and endpoint for Anthropic', async () => {
    const config = await load({
      DREFYN_MODEL_PROVIDER: 'anthropic',
      DREFYN_MODEL_KEY_FILE: '/run/secrets/model-key',
    });
    expect(ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    expect(ANTHROPIC_DEFAULT_BASE_URL).toBe('https://api.anthropic.com');
    expect(plain(config)).toEqual({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      key: KEY,
      model: 'claude-sonnet-5-5',
      allowPrivateCidrs: [],
    });
  });

  it('takes a named model and endpoint', async () => {
    const config = await load({
      DREFYN_MODEL_PROVIDER: 'anthropic',
      DREFYN_MODEL_KEY_FILE: '/run/secrets/model-key',
      DREFYN_MODEL_NAME: 'claude-opus-5-5',
      DREFYN_MODEL_BASE_URL: 'https://gateway.example.com/anthropic',
    });
    expect(plain(config)).toMatchObject({
      model: 'claude-opus-5-5',
      baseUrl: 'https://gateway.example.com/anthropic',
    });
  });

  it('reads a local OpenAI compatible endpoint with no key', async () => {
    const config = await load({
      DREFYN_MODEL_PROVIDER: 'openai_compatible',
      DREFYN_MODEL_BASE_URL: 'http://ollama:11434/v1',
      DREFYN_MODEL_NAME: 'llama3.1:8b',
      DREFYN_MODEL_ALLOW_PRIVATE_CIDRS: '172.16.0.0/12, 127.0.0.0/8',
    });
    expect(plain(config)).toEqual({
      kind: 'openai_compatible',
      baseUrl: 'http://ollama:11434/v1',
      key: undefined,
      model: 'llama3.1:8b',
      allowPrivateCidrs: ['172.16.0.0/12', '127.0.0.0/8'],
    });
  });

  it('accepts the model names local servers use', async () => {
    for (const name of ['llama3.1:8b', 'meta-llama/Llama-3.1-8B-Instruct', 'qwen2.5-coder_7b']) {
      const config = await load({
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'https://models.example.com/v1',
        DREFYN_MODEL_NAME: name,
      });
      expect(config.kind !== 'none' && config.model).toBe(name);
    }
  });

  it.each([
    [{ DREFYN_MODEL_PROVIDER: 'gemini' }, 'DREFYN_MODEL_PROVIDER'],
    [{ DREFYN_MODEL_NAME: 'x' }, 'DREFYN_MODEL_PROVIDER'],
    [{ DREFYN_MODEL_BASE_URL: 'https://x.example.com' }, 'DREFYN_MODEL_PROVIDER'],
    [{ DREFYN_MODEL_PROVIDER: 'anthropic' }, 'DREFYN_MODEL_KEY_FILE'],
    [
      { DREFYN_MODEL_PROVIDER: 'anthropic', DREFYN_MODEL_KEY_FILE: '/missing' },
      'DREFYN_MODEL_KEY_FILE',
    ],
    [
      { DREFYN_MODEL_PROVIDER: 'openai_compatible', DREFYN_MODEL_NAME: 'm' },
      'DREFYN_MODEL_BASE_URL',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'https://x.example.com/v1',
      },
      'DREFYN_MODEL_NAME',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'https://x.example.com/v1',
        DREFYN_MODEL_NAME: 'has space',
      },
      'DREFYN_MODEL_NAME',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'https://user:secret@x.example.com/v1',
        DREFYN_MODEL_NAME: 'm',
      },
      'DREFYN_MODEL_BASE_URL',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'https://x.example.com/v1?key=secret',
        DREFYN_MODEL_NAME: 'm',
      },
      'DREFYN_MODEL_BASE_URL',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'http://public.example.com/v1',
        DREFYN_MODEL_NAME: 'm',
      },
      'DREFYN_MODEL_BASE_URL',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'http://ollama:11434/v1',
        DREFYN_MODEL_NAME: 'm',
        DREFYN_MODEL_ALLOW_PRIVATE_CIDRS: '10.0.0.0/33',
      },
      'DREFYN_MODEL_ALLOW_PRIVATE_CIDRS',
    ],
    [
      {
        DREFYN_MODEL_PROVIDER: 'openai_compatible',
        DREFYN_MODEL_BASE_URL: 'http://ollama:11434/v1',
        DREFYN_MODEL_NAME: 'm',
        DREFYN_MODEL_ALLOW_PRIVATE_CIDRS: ' , ',
      },
      'DREFYN_MODEL_ALLOW_PRIVATE_CIDRS',
    ],
  ])('refuses %j naming the field %s and never the value', async (env, field) => {
    const error = await failure(env);
    expect(error.code).toBe('MODEL_CONFIG_INVALID');
    expect(error.field).toBe(field);
    expect(error.message).toBe(`model config: ${field} is invalid`);
    for (const value of Object.values(env)) {
      if (value.length > 3) expect(JSON.stringify(error) + String(error)).not.toContain(value);
    }
  });

  it('reads the key file with the default reader when none is given', async () => {
    const thrown = await loadModelConfig({
      DREFYN_MODEL_PROVIDER: 'anthropic',
      DREFYN_MODEL_KEY_FILE: '/nonexistent/drefyn-model-key',
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ModelConfigError);
    expect((thrown as ModelConfigError).field).toBe('DREFYN_MODEL_KEY_FILE');
  });
});
