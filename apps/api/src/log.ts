export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Fields are ids, routes, statuses and timings. Never a body, a header, a query string, a key or
// an address: the request log of a public API is the first place any of those would leak.
export interface ApiLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type LineWriter = (line: string) => void;

const toStderr: LineWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

// One JSON line per event. The level, event and service come last, so no field can stand in
// for them.
export function createJsonLogger(write: LineWriter = toStderr): ApiLogger {
  const emit = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}) => {
    try {
      write(JSON.stringify({ ...fields, level, event, service: 'api' }));
    } catch {
      // A log line is never worth a failed request.
    }
  };
  return Object.freeze({
    info: (event: string, fields?: LogFields) => {
      emit('info', event, fields);
    },
    warn: (event: string, fields?: LogFields) => {
      emit('warn', event, fields);
    },
    error: (event: string, fields?: LogFields) => {
      emit('error', event, fields);
    },
  });
}
