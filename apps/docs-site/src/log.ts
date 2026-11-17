export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Fields are ids, outcomes, codes, statuses and timings. Never a host, path, header or body:
// a custom domain or a path can name a person, and this log sees every public request.
export interface DocsLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type LineWriter = (line: string) => void;

const toStderr: LineWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

// One JSON line per event. Level, event and service go last so no field can stand in for them.
export function createJsonLogger(write: LineWriter = toStderr): DocsLogger {
  const emit = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}) => {
    try {
      write(JSON.stringify({ ...fields, level, event, service: 'docs-site' }));
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
