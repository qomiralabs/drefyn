import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import type { LogFields, ModelCallGate, ModelDeps, ModelLogger } from '../../src/index.ts';

export const TENANT: TenantRef = {
  organizationId: organizationId('01928c3e-7a9b-7c3d-8e4f-0123456789ab'),
  projectId: projectId('01928c3e-7a9b-7c3d-8e4f-0123456789cd'),
};

// Long enough to look real, and easy to search for in captured output.
export const KEY = 'sk-fake-0123456789abcdefKQ7z';
export const HINT = 'KQ7z';

export const SYSTEM = 'SYSTEM-PROMPT-SENTINEL: answer from the sources only';
export const PROMPT = 'PROMPT-SENTINEL: how do I rotate a token?';
export const ANSWER = 'ANSWER-SENTINEL: open Settings, then Tokens.';

export interface LogRecord {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: LogFields;
}

export interface CapturingLogger extends ModelLogger {
  readonly records: LogRecord[];
}

export function capturingLogger(): CapturingLogger {
  const records: LogRecord[] = [];
  return {
    records,
    info: (event, fields) => {
      records.push({ level: 'info', event, fields });
    },
    warn: (event, fields) => {
      records.push({ level: 'warn', event, fields });
    },
  };
}

export interface Gate extends ModelCallGate {
  on: boolean;
  readonly asked: { readonly name: string; readonly organizationId: string }[];
}

export function gate(on = true): Gate {
  const asked: { name: string; organizationId: string }[] = [];
  const state: Gate = {
    on,
    asked,
    isOn: (name, ctx) => {
      asked.push({ name, organizationId: ctx.organizationId });
      return Promise.resolve(state.on);
    },
  };
  return state;
}

export interface TestDeps extends ModelDeps {
  readonly logger: CapturingLogger;
  readonly gate: Gate;
  readonly sleeps: number[];
  readonly metricsSeen: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
}

export interface TestDepsOptions {
  // Leave out the recorded sleep, the fixed jitter or the metrics sink, to test the defaults.
  readonly realSleep?: boolean;
  readonly realRandom?: boolean;
  readonly noMetrics?: boolean;
}

// Backoff waits are recorded, not slept, so retry tests run in milliseconds.
export function testDeps(
  overrides: Partial<ModelDeps> = {},
  options: TestDepsOptions = {},
): TestDeps {
  const sleeps: number[] = [];
  const metricsSeen: { name: string; labels: Readonly<Record<string, string>> }[] = [];
  const logger = capturingLogger();
  const callGate = gate(true);
  const deps: TestDeps = {
    logger,
    gate: callGate,
    sleeps,
    metricsSeen,
    ...(options.realRandom === true ? {} : { random: () => 0.5 }),
    ...(options.realSleep === true
      ? {}
      : {
          sleep: (ms: number) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        }),
    ...(options.noMetrics === true
      ? {}
      : {
          metrics: {
            increment: (name: string, labels: Readonly<Record<string, string>>) => {
              metricsSeen.push({ name, labels });
            },
            observe: (name: string, _value: number, labels: Readonly<Record<string, string>>) => {
              metricsSeen.push({ name, labels });
            },
          },
        }),
  };
  return { ...deps, ...overrides } as TestDeps;
}

export const signal = (): AbortSignal => new AbortController().signal;

export const LOOPBACK = ['127.0.0.0/8'] as const;
