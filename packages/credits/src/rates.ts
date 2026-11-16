import { credits, type Credits } from './amounts.ts';
import { AI_OPERATIONS, type AiOperation } from './budget.ts';

// Not exported, so the only way to hold Millicredits is through parseRateTable().
declare const millicreditsBrand: unique symbol;

// Thousandths of a credit per million tokens. A thousandth keeps a rate derived by division
// storable as an integer while the error stays far below one credit.
export type Millicredits = number & { readonly [millicreditsBrand]: true };

export interface RateBand {
  // Largest prompt this band covers, counted over input and cache tokens. Null on the last
  // band only, so every prompt size has a band.
  readonly upToPromptTokens: number | null;
  readonly input: Millicredits;
  readonly cacheWrite5m: Millicredits;
  readonly cacheWrite1h: Millicredits;
  readonly cacheRead: Millicredits;
  readonly output: Millicredits;
}

export interface ModelRate {
  readonly modelId: string;
  readonly premium: boolean;
  readonly bands: readonly [RateBand, ...RateBand[]];
}

export interface TokenUsage {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface ReferenceUsage {
  readonly operation: AiOperation;
  readonly calls: readonly { readonly role: 'main' | 'check'; readonly usage: TokenUsage }[];
}

export interface RateTable {
  readonly version: string;
  readonly models: readonly ModelRate[];
  readonly defaults: Readonly<Record<AiOperation, string>>;
  readonly checkModel: string;
  readonly reference: readonly ReferenceUsage[];
}

export interface ModelCall {
  readonly modelId: string;
  readonly usage: TokenUsage;
}

export interface PlannedCall {
  readonly modelId: string;
  readonly maxPromptTokens: number;
  readonly maxOutputTokens: number;
}

export type RateTableErrorCode = 'RATE_TABLE_INVALID' | 'RATE_MODEL_UNKNOWN' | 'RATE_USAGE_INVALID';

// Fixed text per code plus a path built from field names and indexes only. The table is
// operator config and usage comes from a provider, so no value from either reaches a log.
const RATE_MESSAGES: Readonly<Record<RateTableErrorCode, string>> = {
  RATE_TABLE_INVALID: 'rate table is invalid',
  RATE_MODEL_UNKNOWN: 'model is not in the rate table',
  RATE_USAGE_INVALID: 'model call or token usage is invalid',
};

export class RateTableError extends Error {
  override readonly name = 'RateTableError';
  readonly code: RateTableErrorCode;
  readonly path: string;

  constructor(code: RateTableErrorCode, path: string) {
    super(`${RATE_MESSAGES[code]} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_CLASSES = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'] as const;
const PROMPT_CLASSES = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;
const ROLES = ['main', 'check'] as const;

// Bounds on what one table or one operation may hold, so a bad file or a runaway caller
// cannot make parsing or charging a run unbounded work.
const MAX_MODELS = 256;
const MAX_BANDS = 16;
const MAX_CALLS = 64;

// Rates are per million tokens and a credit is a thousand millicredits.
const PER_CREDIT = 1_000_000_000n;

const TABLE_FIELDS = ['version', 'models', 'defaults', 'checkModel', 'reference'] as const;
const MODEL_FIELDS = ['modelId', 'premium', 'bands'] as const;
const BAND_FIELDS = ['upToPromptTokens', ...TOKEN_CLASSES] as const;
const REFERENCE_FIELDS = ['operation', 'calls'] as const;
const REFERENCE_CALL_FIELDS = ['role', 'usage'] as const;

function invalid(path: string): RateTableError {
  return new RateTableError('RATE_TABLE_INVALID', path);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Own properties only, read once, as in the ledger: an inherited field is not part of the
// table, and a getter read twice could pass a check and then change.
function own(target: object, name: string): unknown {
  return Object.hasOwn(target, name) ? (target as Record<string, unknown>)[name] : undefined;
}

// Unknown fields are refused rather than ignored, so a misspelt rate never silently falls
// back to nothing. The path names the object, never the stray key, which is input.
function objectAt(value: unknown, fields: readonly string[], path: string): object {
  if (!isRecord(value)) throw invalid(path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw invalid(path);
  }
  return value;
}

function arrayAt(value: unknown, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(path);
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw invalid(`${path}[${String(index)}]`);
    items.push((value as unknown[])[index]);
  }
  return items;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function countAt(value: unknown, path: string): number {
  if (!isCount(value)) throw invalid(path);
  return value === 0 ? 0 : value;
}

function stringAt(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(path);
  return value;
}

function bandAt(value: unknown, path: string, last: boolean, floor: number | null): RateBand {
  const body = objectAt(value, BAND_FIELDS, path);
  const boundPath = `${path}.upToPromptTokens`;
  const rawBound = own(body, 'upToPromptTokens');
  let bound: number | null;
  if (last) {
    if (rawBound !== null) throw invalid(boundPath);
    bound = null;
  } else {
    bound = countAt(rawBound, boundPath);
    if (floor !== null && bound <= floor) throw invalid(boundPath);
  }
  const rate = (name: (typeof TOKEN_CLASSES)[number]): Millicredits =>
    countAt(own(body, name), `${path}.${name}`) as Millicredits;
  return Object.freeze({
    upToPromptTokens: bound,
    input: rate('input'),
    cacheWrite5m: rate('cacheWrite5m'),
    cacheWrite1h: rate('cacheWrite1h'),
    cacheRead: rate('cacheRead'),
    output: rate('output'),
  });
}

function modelAt(value: unknown, path: string): ModelRate {
  const body = objectAt(value, MODEL_FIELDS, path);
  const modelId = stringAt(own(body, 'modelId'), MODEL_ID, `${path}.modelId`);
  const premium = own(body, 'premium');
  if (typeof premium !== 'boolean') throw invalid(`${path}.premium`);
  const rawBands = arrayAt(own(body, 'bands'), MAX_BANDS, `${path}.bands`);
  if (rawBands.length === 0) throw invalid(`${path}.bands`);
  const bands: RateBand[] = [];
  let floor: number | null = null;
  for (const [index, raw] of rawBands.entries()) {
    const band = bandAt(
      raw,
      `${path}.bands[${String(index)}]`,
      index === rawBands.length - 1,
      floor,
    );
    bands.push(band);
    floor = band.upToPromptTokens;
  }
  return Object.freeze({
    modelId,
    premium,
    bands: Object.freeze(bands) as unknown as readonly [RateBand, ...RateBand[]],
  });
}

function usageAt(value: unknown, path: string, fail: (path: string) => RateTableError): TokenUsage {
  if (!isRecord(value)) throw fail(path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !(TOKEN_CLASSES as readonly string[]).includes(key)) {
      throw fail(path);
    }
  }
  const count = (name: (typeof TOKEN_CLASSES)[number]): number => {
    const raw = own(value, name);
    if (!isCount(raw)) throw fail(`${path}.${name}`);
    return raw === 0 ? 0 : raw;
  };
  return Object.freeze({
    input: count('input'),
    cacheWrite5m: count('cacheWrite5m'),
    cacheWrite1h: count('cacheWrite1h'),
    cacheRead: count('cacheRead'),
    output: count('output'),
  });
}

function referenceAt(value: unknown, path: string): ReferenceUsage {
  const body = objectAt(value, REFERENCE_FIELDS, path);
  const rawOperation = own(body, 'operation');
  const operation = AI_OPERATIONS.find((known) => known === rawOperation);
  if (operation === undefined) throw invalid(`${path}.operation`);
  const rawCalls = arrayAt(own(body, 'calls'), MAX_CALLS, `${path}.calls`);
  if (rawCalls.length === 0) throw invalid(`${path}.calls`);
  const calls = rawCalls.map((raw, index) => {
    const callPath = `${path}.calls[${String(index)}]`;
    const call = objectAt(raw, REFERENCE_CALL_FIELDS, callPath);
    const rawRole = own(call, 'role');
    const role = ROLES.find((known) => known === rawRole);
    if (role === undefined) throw invalid(`${callPath}.role`);
    return Object.freeze({
      role,
      usage: usageAt(own(call, 'usage'), `${callPath}.usage`, invalid),
    });
  });
  return Object.freeze({ operation, calls: Object.freeze(calls) });
}

// Checks every rule and returns a frozen copy holding only the known fields, so the result
// serializes back to an equal table and nothing the caller keeps can change it.
export function parseRateTable(value: unknown): RateTable {
  const body = objectAt(value, TABLE_FIELDS, 'table');
  const version = stringAt(own(body, 'version'), VERSION, 'version');

  const rawModels = arrayAt(own(body, 'models'), MAX_MODELS, 'models');
  if (rawModels.length === 0) throw invalid('models');
  const models: ModelRate[] = [];
  const byId = new Map<string, ModelRate>();
  for (const [index, raw] of rawModels.entries()) {
    const path = `models[${String(index)}]`;
    const model = modelAt(raw, path);
    if (byId.has(model.modelId)) throw invalid(`${path}.modelId`);
    byId.set(model.modelId, model);
    models.push(model);
  }

  const rawDefaults = objectAt(own(body, 'defaults'), AI_OPERATIONS, 'defaults');
  const defaults: Partial<Record<AiOperation, string>> = {};
  for (const operation of AI_OPERATIONS) {
    const path = `defaults.${operation}`;
    const modelId = own(rawDefaults, operation);
    const model = typeof modelId === 'string' ? byId.get(modelId) : undefined;
    // A default must be open to every plan, so it can never be a premium model.
    if (model === undefined || model.premium) throw invalid(path);
    defaults[operation] = model.modelId;
  }

  const rawCheck = own(body, 'checkModel');
  const check = typeof rawCheck === 'string' ? byId.get(rawCheck) : undefined;
  if (check === undefined) throw invalid('checkModel');

  const rawReference = arrayAt(own(body, 'reference'), AI_OPERATIONS.length, 'reference');
  const reference: ReferenceUsage[] = [];
  const seen = new Set<AiOperation>();
  for (const [index, raw] of rawReference.entries()) {
    const path = `reference[${String(index)}]`;
    const profile = referenceAt(raw, path);
    if (seen.has(profile.operation)) throw invalid(`${path}.operation`);
    seen.add(profile.operation);
    reference.push(profile);
  }

  return Object.freeze({
    version,
    models: Object.freeze(models),
    defaults: Object.freeze(defaults as Record<AiOperation, string>),
    checkModel: check.modelId,
    reference: Object.freeze(reference),
  });
}

function usageInvalid(path: string): RateTableError {
  return new RateTableError('RATE_USAGE_INVALID', path);
}

function callsAt(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CALLS) {
    throw usageInvalid('calls');
  }
  return value as readonly unknown[];
}

function modelOf(table: RateTable, raw: unknown, path: string): ModelRate {
  const model =
    typeof raw === 'string' ? table.models.find((known) => known.modelId === raw) : undefined;
  if (model === undefined) throw new RateTableError('RATE_MODEL_UNKNOWN', path);
  return model;
}

// The provider picks the band from the whole prompt, cache tokens included.
function bandIndexFor(model: ModelRate, promptTokens: bigint): number {
  const last = model.bands.length - 1;
  for (let index = 0; index < last; index += 1) {
    const bound = model.bands[index]?.upToPromptTokens;
    if (bound !== null && bound !== undefined && promptTokens <= BigInt(bound)) return index;
  }
  return last;
}

function asCredits(value: bigint): Credits {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw usageInvalid('calls');
  return credits(Number(value));
}

// Millicredits per million tokens times tokens, summed over every call of one operation.
function usageSum(table: RateTable, calls: readonly unknown[]): bigint {
  let sum = 0n;
  for (const [index, raw] of calls.entries()) {
    const path = `calls[${String(index)}]`;
    if (!isRecord(raw)) throw usageInvalid(path);
    const model = modelOf(table, own(raw, 'modelId'), `${path}.modelId`);
    const usage = usageAt(own(raw, 'usage'), `${path}.usage`, usageInvalid);
    let prompt = 0n;
    for (const name of PROMPT_CLASSES) prompt += BigInt(usage[name]);
    const band = model.bands[bandIndexFor(model, prompt)];
    if (band === undefined) throw usageInvalid(path);
    for (const name of TOKEN_CLASSES) sum += BigInt(usage[name]) * BigInt(band[name]);
  }
  return sum;
}

// What an operation costs once its usage is known. All calls are summed first and rounded
// once, half up, so splitting a run into more calls never adds rounding. At least one credit,
// since the ledger records no empty entries.
export function creditsForUsage(table: RateTable, calls: readonly ModelCall[]): Credits {
  const sum = usageSum(table, callsAt(calls));
  const rounded = (2n * sum + PER_CREDIT) / (2n * PER_CREDIT);
  return asCredits(rounded > 1n ? rounded : 1n);
}

// An upper bound for the hold. Each prompt token is taken at the dearest prompt rate of
// every band up to the one the largest prompt lands in, and every output token at the
// dearest output rate there, so no usage inside the plan can cost more. Rounded up.
export function estimateCredits(table: RateTable, calls: readonly PlannedCall[]): Credits {
  let sum = 0n;
  for (const [index, raw] of callsAt(calls).entries()) {
    const path = `calls[${String(index)}]`;
    if (!isRecord(raw)) throw usageInvalid(path);
    const model = modelOf(table, own(raw, 'modelId'), `${path}.modelId`);
    const prompt = own(raw, 'maxPromptTokens');
    const output = own(raw, 'maxOutputTokens');
    if (!isCount(prompt)) throw usageInvalid(`${path}.maxPromptTokens`);
    if (!isCount(output)) throw usageInvalid(`${path}.maxOutputTokens`);
    const top = bandIndexFor(model, BigInt(prompt));
    let promptRate = 0;
    let outputRate = 0;
    for (const band of model.bands.slice(0, top + 1)) {
      for (const name of PROMPT_CLASSES) promptRate = Math.max(promptRate, band[name]);
      outputRate = Math.max(outputRate, band.output);
    }
    sum += BigInt(prompt) * BigInt(promptRate) + BigInt(output) * BigInt(outputRate);
  }
  const rounded = (sum + PER_CREDIT - 1n) / PER_CREDIT;
  return asCredits(rounded > 1n ? rounded : 1n);
}

// "About N runs a month" for one operation on one model: the monthly credits over the charge
// for the measured reference run, rounded down. Undefined with no reference, so nothing is
// shown rather than a guess.
export function estimateMonthlyRuns(
  table: RateTable,
  monthly: Credits,
  operation: AiOperation,
  modelId: string,
): number | undefined {
  const pool = credits(monthly);
  const known = AI_OPERATIONS.find((name) => name === operation);
  if (known === undefined) throw usageInvalid('operation');
  const model = modelOf(table, modelId, 'modelId');
  const profile = table.reference.find((entry) => entry.operation === known);
  if (profile === undefined) return undefined;
  const calls = profile.calls.map((call) => ({
    modelId: call.role === 'main' ? model.modelId : table.checkModel,
    usage: call.usage,
  }));
  const charge = creditsForUsage(table, calls);
  return Number(BigInt(pool) / BigInt(charge));
}
