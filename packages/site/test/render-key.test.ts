import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CacheKey } from '@drefyn/tenancy';
import { renderKey } from '../src/index.ts';
import { otherOrganization, otherProject, pageInput, tenant } from './fixtures.ts';

describe('renderKey', () => {
  it('starts with both ids', () => {
    expect(renderKey('docs', pageInput())).toMatch(
      new RegExp(`^v1:${tenant.organizationId}:${tenant.projectId}:render:`),
    );
    expectTypeOf(renderKey('docs', pageInput())).toEqualTypeOf<CacheKey>();
  });

  it('never gives two tenants one key for the same page', () => {
    const keys = [tenant, otherProject, otherOrganization].map((t) =>
      renderKey('status', pageInput({ tenant: t })),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ['route', pageInput({ route: '/other' })],
    ['locale', pageInput({ locale: 'de' })],
    ['policy version', pageInput({ policy: { version: 2, maxFirstResponseBytes: 14_000 } })],
    ['data version', pageInput({}, { version: 'ver-2' })],
  ])('changes with the %s', (_, changed) => {
    expect(renderKey('docs', changed)).not.toBe(renderKey('docs', pageInput()));
  });

  it('keeps the two surfaces apart', () => {
    expect(renderKey('docs', pageInput())).not.toBe(renderKey('status', pageInput()));
  });

  it('holds no route text', () => {
    expect(renderKey('docs', pageInput({ route: '/private-launch' }))).not.toContain('private');
  });
});
