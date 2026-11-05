import { describe, expect, it } from 'vitest';
import { ENGINE_ERROR_CODES, NODE_FAMILIES, NODE_LIFECYCLES, ORIGINS } from '../src/index.ts';

describe('the closed sets', () => {
  it('lists the seven node families', () => {
    expect(NODE_FAMILIES).toEqual([
      'docs_page',
      'studio_item',
      'status_component',
      'status_incident',
      'status_incident_update',
      'status_maintenance',
      'status_postmortem',
    ]);
  });

  it('lists the lifecycle states', () => {
    expect(NODE_LIFECYCLES).toEqual(['draft', 'published', 'archived']);
  });

  it('lists the origins', () => {
    expect(ORIGINS).toEqual(['human', 'ai', 'git', 'import']);
  });

  it('lists the stable error codes', () => {
    expect(ENGINE_ERROR_CODES).toEqual([
      'engine.not_found',
      'engine.forbidden',
      'engine.version_conflict',
      'engine.validation_failed',
      'engine.idempotency_conflict',
      'engine.limit_reached',
      'engine.filter_not_declared',
      'engine.filter_backfilling',
      'engine.read_only',
      'engine.too_large',
    ]);
  });

  // Callers branch on these, so a push from anywhere would change the contract for everyone.
  it.each([
    ['NODE_FAMILIES', NODE_FAMILIES],
    ['NODE_LIFECYCLES', NODE_LIFECYCLES],
    ['ORIGINS', ORIGINS],
    ['ENGINE_ERROR_CODES', ENGINE_ERROR_CODES],
  ])('freezes %s', (_name, list) => {
    expect(Object.isFrozen(list)).toBe(true);
  });
});
