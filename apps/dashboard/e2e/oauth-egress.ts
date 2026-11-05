import { fakeUrl, PROVIDER_HOSTS } from './oauth-fake.ts';

// Auth's fetch goes to the real hosts, in https, with every check it has in production. Under
// it this hands those requests to the fake and lets nothing else off the machine, so the
// build under test holds no switch that could point OAuth somewhere else.

export const EGRESS_LEDGER_URL = new URL('./.auth/egress.log', import.meta.url);
export const PROVIDER_COUNT = PROVIDER_HOSTS.length;

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

type Fetch = typeof globalThis.fetch;

export function routedFetch(real: Fetch, note: (line: string) => void): Fetch {
  return (input, init) => {
    const request = input instanceof Request ? input.url : input;
    const url = new URL(request);
    if (LOOPBACK.has(url.hostname)) return real(input, init);
    if (PROVIDER_HOSTS.includes(url.hostname)) return real(fakeUrl(url), init);
    note(url.host);
    return Promise.reject(new TypeError('fetch failed'));
  };
}

// The hosts every browser and server in the Playwright container must see as loopback.
export function unblockedHosts(hostsFile: string): readonly string[] {
  const blocked = new Set(
    hostsFile
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([address]) => address === '127.0.0.1')
      .flatMap(([, ...names]) => names),
  );
  return PROVIDER_HOSTS.filter((host) => !blocked.has(host));
}

export function egressProblems(hostsFile: string, ledger: string): readonly string[] {
  const strays = ledger.split('\n').filter((line) => line !== '');
  return [
    ...unblockedHosts(hostsFile).map((host) => `${host} is not blocked in this container`),
    ...strays.map((host) => `a server tried to reach ${host}`),
  ];
}
