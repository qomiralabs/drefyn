import type { FlagContext } from '@drefyn/flags';

export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Fields are ids, hashes, sizes and codes. Nothing here ever carries content or an actor's
// details, and an event names what happened, so a log search needs no message text.
export interface EngineLogger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export interface EngineTracer {
  span<T>(name: string, fields: LogFields, work: () => Promise<T>): Promise<T>;
  // A step that ran in another process, so it can only be told after the fact.
  record(name: string, fields: LogFields, durationMs: number): void;
}

export interface EngineFlagAnswer {
  readonly value: boolean;
  // Set when the value is a fallback and not a reading, which a plain boolean cannot show.
  readonly errorCode?: string;
}

export interface EngineFlags {
  evaluate(
    name: 'engine.writes' | 'engine.chunk_at_write',
    context: FlagContext,
  ): Promise<EngineFlagAnswer>;
}

export const noopLogger: EngineLogger = { info: () => undefined, warn: () => undefined };

export const noopTracer: EngineTracer = {
  span: (_name, _fields, work) => work(),
  record: () => undefined,
};
