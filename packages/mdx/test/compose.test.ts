import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { assertHostEnv, parseHostConfig } from '../src/host-config.ts';

// What can be read off the files. scripts/selfhost-parse-test.sh proves the same things from
// real containers, and this catches a drift on every run without needing Docker.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(resolve(workspace, path), 'utf8');

const composeSchema = z.object({
  services: z.record(
    z.string(),
    z.looseObject({
      environment: z.record(z.string(), z.string()).optional(),
      networks: z.array(z.string()).optional(),
      ports: z.array(z.unknown()).optional(),
      secrets: z.array(z.unknown()).optional(),
      volumes: z.array(z.unknown()).optional(),
      env_file: z.unknown().optional(),
    }),
  ),
  networks: z.record(
    z.string(),
    z.looseObject({
      internal: z.boolean().optional(),
      driver_opts: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

const compose = composeSchema.parse(parse(read('deploy/compose.yaml')));
const { 'parse-host': service } = compose.services;
if (service === undefined) throw new Error('no parse-host service');

describe('the parse host service', () => {
  it('sits only on a network with no way out', () => {
    expect(service.networks).toEqual(['parse']);
    expect(compose.networks['parse']?.internal).toBe(true);
  });

  // Found on a real engine: internal drops the route, but the bridge keeps an address on the
  // machine, and a listener on all interfaces answers there.
  it('leaves the machine no address on that network', () => {
    expect(compose.networks['parse']?.driver_opts).toEqual({
      'com.docker.network.bridge.inhibit_ipv4': 'true',
    });
  });

  it('is the only service on it until an app tier joins', () => {
    const others = Object.entries(compose.services)
      .filter(([name, { networks }]) => name !== 'parse-host' && networks?.includes('parse'))
      .map(([name]) => name);
    expect(others).toEqual([]);
  });

  it('publishes no port', () => {
    expect(service.ports).toBeUndefined();
  });

  it('is handed no secret, file of settings or volume', () => {
    expect(service.secrets).toBeUndefined();
    expect(service.env_file).toBeUndefined();
    expect(service.volumes).toBeUndefined();
  });

  it('sets only keys the host would accept', () => {
    expect(() => {
      assertHostEnv(service.environment ?? {});
    }).not.toThrow();
  });

  it('has an OS memory limit that follows the setting the host checks at start', () => {
    const setting = '${DREFYN_PARSE_HOST_MEMORY_MB:-2048}';
    expect(service['mem_limit']).toBe(`${setting}m`);
    expect(service['memswap_limit']).toBe(`${setting}m`);
    expect(service.environment?.['DREFYN_PARSE_HOST_MEMORY_MB']).toBe(setting);
    expect(
      parseHostConfig({
        DREFYN_PARSE_TOKEN_SHA256: 'a'.repeat(64),
        DREFYN_PARSE_HOST_MEMORY_MB: '2048',
      }).hostMemoryMb,
    ).toBe(2_048);
  });

  it('drops what a parser never needs', () => {
    expect(service['cap_drop']).toEqual(['ALL']);
    expect(service['security_opt']).toEqual(['no-new-privileges:true']);
    expect(service['read_only']).toBe(true);
    expect(service['pids_limit']).toBeGreaterThan(0);
  });

  it('leaves the token hash empty unless it is set, so a host cannot start on a default', () => {
    expect(service.environment?.['DREFYN_PARSE_TOKEN_SHA256']).toBe(
      '${DREFYN_PARSE_TOKEN_SHA256:-}',
    );
    expect(() => parseHostConfig({ DREFYN_PARSE_TOKEN_SHA256: '' })).toThrow();
  });

  it('runs one way, with the flags the host expects and no write or addon allowed', () => {
    const line = read('deploy/parse-host/Dockerfile')
      .split('\n')
      .find((text) => text.startsWith('CMD '));
    expect(z.array(z.string()).parse(JSON.parse(line?.slice('CMD '.length) ?? ''))).toEqual([
      'node',
      '--permission',
      '--allow-fs-read=/app',
      '--allow-child-process',
      'packages/mdx/src/supervisor-main.ts',
    ]);
  });

  it('runs as the unprivileged user, from a base pinned by digest', () => {
    const file = read('deploy/parse-host/Dockerfile');
    expect(file).toMatch(/^USER node$/m);
    for (const line of file.split('\n').filter((text) => text.startsWith('FROM '))) {
      expect(line).toMatch(/^FROM node:[0-9.]+-[a-z-]+@sha256:[0-9a-f]{64}( AS [a-z]+)?$/);
    }
  });
});
