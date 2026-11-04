import { describe, expect, it, vi } from 'vitest';
import { redactedRequestError } from '../src/server/request-error.ts';

const SECRETS = {
  cookie: 'drefyn_session=v1.abc.def.ghi',
  code: '12345678',
  token: 'drf_ak_abcdefghijklmnop',
  password: 'correct horse battery staple',
};

const error = Object.assign(
  new Error(
    `failed for password ${SECRETS.password} with code=${SECRETS.code} and ${SECRETS.token}`,
  ),
  { digest: '123456', cause: SECRETS.cookie, stack: `at ${SECRETS.password}` },
);
const request = {
  path: `/invite/${SECRETS.token}?code=${SECRETS.code}`,
  method: 'POST',
  headers: { cookie: SECRETS.cookie, authorization: `Bearer ${SECRETS.token}` },
};
const context = {
  routerKind: 'App Router',
  routePath: '/[org]/page',
  routeType: 'render',
  renderSource: 'server-rendering',
  revalidateReason: undefined,
};

describe('redactedRequestError', () => {
  it('keeps what ties a report to a route, and nothing a person typed', () => {
    expect(redactedRequestError(error, request, context)).toEqual({
      digest: '123456',
      name: 'Error',
      method: 'POST',
      routePath: '/[org]/page',
      routeType: 'render',
    });
  });

  it.each(Object.entries(SECRETS))('never carries the %s', (_name, secret) => {
    const line = JSON.stringify(redactedRequestError(error, request, context));
    expect(line).not.toContain(secret);
  });

  it('drops a name or digest that is not a plain word', () => {
    const odd = Object.assign(new Error('x'), { name: SECRETS.password, digest: SECRETS.cookie });
    const fields = redactedRequestError(odd, request, context);
    expect(fields).not.toHaveProperty('digest');
    expect(fields['name']).toBe('Error');
  });

  it('copes with something that is not an error', () => {
    expect(redactedRequestError('boom', { method: 'GET' }, {})).toEqual({
      name: 'Error',
      method: 'GET',
    });
  });

  it('logs one line through the instrumentation hook', async () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { onRequestError } = await import('../src/instrumentation.ts');
    onRequestError(error, request, context);
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ level: 'error', event: 'dashboard.request_error' });
    for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret);
  });
});
