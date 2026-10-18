import { describe, expect, it } from 'vitest';
import { evaluatePrerequisites } from '../src/prerequisites.ts';

const COMPOSE_UPDATE =
  "docker compose -f deploy/compose.yaml exec -T postgres psql --no-psqlrc -U postgres -d drefyn -c 'alter extension vector update'";
const MANAGED_UPDATE = "alter extension vector update to '<version>'";

function failure(result: ReturnType<typeof evaluatePrerequisites>) {
  if (result.ok) throw new Error('expected the prerequisite check to fail');
  return result;
}

describe('evaluatePrerequisites', () => {
  it('passes for vector in extensions at exactly 0.8.2', () => {
    expect(evaluatePrerequisites({ schema: 'extensions', version: '0.8.2' })).toEqual({ ok: true });
  });

  it('passes for vector in extensions at 0.8.7, the compose image', () => {
    expect(evaluatePrerequisites({ schema: 'extensions', version: '0.8.7' })).toEqual({ ok: true });
  });

  it('passes for later versions compared as numbers', () => {
    expect(evaluatePrerequisites({ schema: 'extensions', version: '0.8.10' })).toEqual({
      ok: true,
    });
    expect(evaluatePrerequisites({ schema: 'extensions', version: '0.10.0' })).toEqual({
      ok: true,
    });
  });

  it('names a missing extension and the superuser step that installs it', () => {
    const result = failure(evaluatePrerequisites(undefined));
    expect(result.problem).toBe('vector_missing');
    expect(result.message).toMatch(/vector/);
    expect(result.message).toMatch(/not installed/i);
    // The bootstrap refuses to run twice, so on an existing database the command is this.
    expect(result.message).toContain('create extension vector schema extensions');
    expect(result.message).toMatch(/superuser|master user/i);
  });

  it('names the schema it found and the command that moves it', () => {
    const result = failure(evaluatePrerequisites({ schema: 'public', version: '0.8.7' }));
    expect(result.problem).toBe('vector_wrong_schema');
    expect(result.message).toContain('public');
    expect(result.message).toContain('extensions');
    expect(result.message).toContain('alter extension vector set schema extensions');
  });

  it('checks the schema before the version', () => {
    const result = failure(evaluatePrerequisites({ schema: 'public', version: '0.8.1' }));
    expect(result.problem).toBe('vector_wrong_schema');
  });

  it.each(['0.8.1', '0.8.0', '0.7.4'])(
    'names the version %s, the floor and both update commands',
    (version) => {
      const result = failure(evaluatePrerequisites({ schema: 'extensions', version }));
      expect(result.problem).toBe('vector_too_old');
      expect(result.message).toContain(version);
      expect(result.message).toContain('0.8.2');
      expect(result.message).toContain(COMPOSE_UPDATE);
      expect(result.message).toContain(MANAGED_UPDATE);
    },
  );

  it('does not read 0.8.10 as older than 0.8.2', () => {
    expect(evaluatePrerequisites({ schema: 'extensions', version: '0.8.10' }).ok).toBe(true);
  });

  it.each(['', '0.8', '0.8.2-dev', 'unknown'])('fails closed on unreadable version %j', (v) => {
    const result = failure(evaluatePrerequisites({ schema: 'extensions', version: v }));
    expect(result.problem).toBe('vector_too_old');
    expect(result.message).toContain(COMPOSE_UPDATE);
  });

  it('treats a schema that only looks like extensions as wrong', () => {
    for (const schema of ['Extensions', 'extensions ', 'app', '"extensions"']) {
      expect(failure(evaluatePrerequisites({ schema, version: '0.8.7' })).problem).toBe(
        'vector_wrong_schema',
      );
    }
  });
});
