import { readFile } from 'node:fs/promises';
import { policyFor } from '@drefyn/egress';
import { z } from 'zod';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  createAnthropicProvider,
} from './anthropic.ts';
import { checkBaseUrl, MODEL_NAME } from './call.ts';
import { ModelKey } from './key.ts';
import { createOpenAiCompatibleProvider } from './openai.ts';
import type { ModelDeps, ModelProvider, ModelProviderKind } from './types.ts';

export type ModelConfigField =
  | 'DREFYN_MODEL_PROVIDER'
  | 'DREFYN_MODEL_BASE_URL'
  | 'DREFYN_MODEL_KEY_FILE'
  | 'DREFYN_MODEL_NAME'
  | 'DREFYN_MODEL_ALLOW_PRIVATE_CIDRS';

const FIELDS: readonly ModelConfigField[] = [
  'DREFYN_MODEL_PROVIDER',
  'DREFYN_MODEL_BASE_URL',
  'DREFYN_MODEL_KEY_FILE',
  'DREFYN_MODEL_NAME',
  'DREFYN_MODEL_ALLOW_PRIVATE_CIDRS',
];

// Startup fails closed on a bad setting and names the setting, never its value: the
// value may be a key, or a URL with one in it.
export class ModelConfigError extends Error {
  readonly code = 'MODEL_CONFIG_INVALID';
  readonly field: ModelConfigField;

  constructor(field: ModelConfigField) {
    super(`model config: ${field} is invalid`);
    this.field = field;
  }
}

Object.defineProperty(ModelConfigError.prototype, 'name', {
  value: 'ModelConfigError',
  enumerable: false,
});

export type ModelConfig =
  | { readonly kind: 'none' }
  | {
      readonly kind: ModelProviderKind;
      readonly baseUrl: string;
      readonly key: ModelKey | undefined;
      readonly model: string;
      readonly allowPrivateCidrs: readonly string[];
    };

export type ModelEnv = Readonly<Record<string, string | undefined>>;

const providerSchema = z.enum(['anthropic', 'openai_compatible']);
const nameSchema = z.string().regex(MODEL_NAME);

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

function cidrsOf(raw: string | undefined): readonly string[] {
  if (!present(raw)) return [];
  const cidrs = raw.split(',').map((part) => part.trim());
  try {
    if (cidrs.some((cidr) => cidr === '')) throw new TypeError('empty range');
    policyFor('model', { allowPrivateCidrs: cidrs });
  } catch {
    throw new ModelConfigError('DREFYN_MODEL_ALLOW_PRIVATE_CIDRS');
  }
  return cidrs;
}

function baseUrlOf(raw: string, cidrs: readonly string[]): string {
  try {
    checkBaseUrl(raw);
  } catch {
    throw new ModelConfigError('DREFYN_MODEL_BASE_URL');
  }
  // Plain http sends the key in the clear, so it is only for a server on a listed range.
  if (raw.trim().toLowerCase().startsWith('http:') && cidrs.length === 0) {
    throw new ModelConfigError('DREFYN_MODEL_BASE_URL');
  }
  return raw.trim();
}

async function keyOf(path: string, read: (path: string) => Promise<string>): Promise<ModelKey> {
  try {
    return new ModelKey((await read(path)).trim());
  } catch {
    throw new ModelConfigError('DREFYN_MODEL_KEY_FILE');
  }
}

const readKeyFile = (path: string): Promise<string> => readFile(path, 'utf8');

/**
 * Reads the DREFYN_MODEL_* settings. Nothing set means no model: AI features stay off and
 * say so. Anthropic needs a key file; an OpenAI compatible endpoint needs a URL and a model
 * name, and a key only if it asks for one.
 */
export async function loadModelConfig(
  env: ModelEnv,
  read: (path: string) => Promise<string> = readKeyFile,
): Promise<ModelConfig> {
  const providerRaw = env['DREFYN_MODEL_PROVIDER'];
  if (!present(providerRaw)) {
    if (FIELDS.some((field) => present(env[field]))) {
      throw new ModelConfigError('DREFYN_MODEL_PROVIDER');
    }
    return { kind: 'none' };
  }
  const provider = providerSchema.safeParse(providerRaw.trim());
  if (!provider.success) throw new ModelConfigError('DREFYN_MODEL_PROVIDER');
  const kind = provider.data;
  const cidrs = cidrsOf(env['DREFYN_MODEL_ALLOW_PRIVATE_CIDRS']);

  const urlRaw = env['DREFYN_MODEL_BASE_URL'];
  if (kind === 'openai_compatible' && !present(urlRaw)) {
    throw new ModelConfigError('DREFYN_MODEL_BASE_URL');
  }
  const baseUrl = baseUrlOf(present(urlRaw) ? urlRaw : ANTHROPIC_DEFAULT_BASE_URL, cidrs);

  const nameRaw = env['DREFYN_MODEL_NAME'];
  if (kind === 'openai_compatible' && !present(nameRaw)) {
    throw new ModelConfigError('DREFYN_MODEL_NAME');
  }
  const name = nameSchema.safeParse(present(nameRaw) ? nameRaw.trim() : ANTHROPIC_DEFAULT_MODEL);
  if (!name.success) throw new ModelConfigError('DREFYN_MODEL_NAME');

  const keyPath = env['DREFYN_MODEL_KEY_FILE'];
  if (kind === 'anthropic' && !present(keyPath)) {
    throw new ModelConfigError('DREFYN_MODEL_KEY_FILE');
  }
  const key = present(keyPath) ? await keyOf(keyPath.trim(), read) : undefined;

  return { kind, baseUrl, key, model: name.data, allowPrivateCidrs: cidrs };
}

const unconfigured: ModelProvider = Object.freeze({
  kind: 'none',
  complete: () =>
    Promise.resolve({
      ok: false,
      error: { code: 'model.not_configured', cause: 'unset', attempts: 0 },
    } as const),
});

/** The provider a config names, or one that answers model.not_configured to every call. */
export function createModelProvider(config: ModelConfig, deps: ModelDeps): ModelProvider {
  if (config.kind === 'none') return unconfigured;
  const options = {
    baseUrl: config.baseUrl,
    model: config.model,
    allowPrivateCidrs: config.allowPrivateCidrs,
    ...(config.key === undefined ? {} : { key: config.key }),
  };
  return config.kind === 'anthropic'
    ? createAnthropicProvider(options, deps)
    : createOpenAiCompatibleProvider(options, deps);
}
