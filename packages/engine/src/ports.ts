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
}

export interface EngineFlags {
  isOn(name: 'engine.writes' | 'engine.chunk_at_write', context: FlagContext): Promise<boolean>;
}

export const noopLogger: EngineLogger = { info: () => undefined, warn: () => undefined };

export const noopTracer: EngineTracer = { span: (_name, _fields, work) => work() };
