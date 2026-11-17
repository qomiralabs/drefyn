import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '../src/index.ts';

describe('createJsonLogger', () => {
  it('writes one JSON line per event, with level, event and service the fields cannot replace', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));
    logger.info('site.request', { status: 200, level: 'debug', event: 'x', service: 'y' });
    logger.warn('site.slow');
    logger.error('site.request_failed', { code: 'site.directory_failed' });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { status: 200, level: 'info', event: 'site.request', service: 'docs-site' },
      { level: 'warn', event: 'site.slow', service: 'docs-site' },
      {
        code: 'site.directory_failed',
        level: 'error',
        event: 'site.request_failed',
        service: 'docs-site',
      },
    ]);
  });

  it('never throws out of a failed write', () => {
    const logger = createJsonLogger(() => {
      throw new Error('stderr closed');
    });
    expect(() => {
      logger.info('site.request');
    }).not.toThrow();
  });

  it('writes to stderr by default', () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };
    try {
      createJsonLogger().info('site.started', { port: 3002 });
    } finally {
      process.stderr.write = original;
    }
    expect(written).toEqual([
      '{"port":3002,"level":"info","event":"site.started","service":"docs-site"}\n',
    ]);
  });
});
