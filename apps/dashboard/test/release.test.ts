import { flags, type FlagClient, type FlagDefinition } from '@drefyn/flags';
import { createTestFlagClient } from '@drefyn/flags/testing';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_FLAG, dashboardEnabled } from '../src/index.ts';

const ORG = 'org_acme';
const registry: readonly FlagDefinition[] = flags;

describe('the dashboard release flag', () => {
  it('is a registered release flag that fails closed', () => {
    const flag = registry.find((f) => (f.name as string) === DASHBOARD_FLAG);
    expect(flag?.kind).toBe('release');
    expect(flag).toMatchObject({ safeValue: false });
  });

  it('is off with the production defaults', async () => {
    const client = createTestFlagClient({}, { env: {} });
    await expect(dashboardEnabled(client, ORG)).resolves.toBe(false);
    await client.close();
  });

  it('is on when the flag is on', async () => {
    const client = createTestFlagClient({}, { env: { DREFYN_RELEASE_FLAGS: 'on' } });
    await expect(dashboardEnabled(client, ORG)).resolves.toBe(true);
    await client.close();
  });

  it('is off when the flag client fails', async () => {
    const broken = {
      isOn: () => Promise.reject(new Error('provider gone')),
      evaluate: () => Promise.reject(new Error('provider gone')),
      close: () => Promise.resolve(),
    } as unknown as FlagClient;
    await expect(dashboardEnabled(broken, ORG)).resolves.toBe(false);
  });

  it('asks about the organization it was given', async () => {
    const seen: unknown[] = [];
    const spy = {
      isOn: (name: string, ctx: unknown) => {
        seen.push([name, ctx]);
        return Promise.resolve(true);
      },
      evaluate: (name: string, ctx: unknown) => {
        seen.push([name, ctx]);
        return Promise.resolve({ value: true, source: 'provider' });
      },
      close: () => Promise.resolve(),
    } as unknown as FlagClient;
    await dashboardEnabled(spy, ORG);
    expect(seen).toEqual([[DASHBOARD_FLAG, expect.objectContaining({ organizationId: ORG })]]);
  });
});
