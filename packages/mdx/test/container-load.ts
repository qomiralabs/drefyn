// Drives the parse host from a container on its network, as the app tier would, through the
// real client. scripts/selfhost-parse-test.sh runs it from the host image with this directory
// mounted read only. Prints one JSON line and exits 1 only when the run itself went wrong.
//
//   print <url>            an honest page at the size limit, parsed then printed, both dialects
//   flood <url> <seconds>  full size parses and prints from many organizations at once
import { createParseClient } from '../src/client.ts';
import type { Dialect } from '../src/index.ts';
import { honestPage } from './honest-page.ts';
import { isolatedPolicy, orgAt, parsed, projectAt } from './helpers.ts';
import { allNew } from './print-helpers.ts';

const DIALECTS: readonly Dialect[] = ['mdx', 'md'];
// Enough organizations and requests in flight to fill every share of the held bytes and keep
// both threads busy, which is the load the memory floor is sized for.
const ORGANIZATIONS = 12;
const IN_FLIGHT_PER_ORGANIZATION = 4;

const [mode = '', url = '', seconds = '0'] = process.argv.slice(2);
const token = process.env['DREFYN_PARSE_HOST_TOKEN'] ?? '';
const client = createParseClient({ url, token, logger: { warn: () => undefined } });
const policy = isolatedPolicy();

const tenant = (index: number) => ({ organizationId: orgAt(index), projectId: projectAt(index) });
const codeOf = (result: { ok: boolean; error?: readonly { code: string }[] }) =>
  result.ok ? 'ok' : (result.error?.[0]?.code ?? 'unknown');

async function printHonest(): Promise<boolean> {
  const runs = [];
  for (const dialect of DIALECTS) {
    const source = honestPage(dialect);
    const started = performance.now();
    const first = await client.parse({
      tenant: tenant(1),
      path: `load/${dialect}`,
      source,
      dialect,
      policy,
    });
    const parseMs = Math.round(performance.now() - started);
    if (!first.ok) {
      runs.push({ dialect, step: 'parse', code: codeOf(first), parseMs });
      continue;
    }
    const printStarted = performance.now();
    const printed = await client.print({
      tenant: tenant(1),
      path: `load/${dialect}`,
      policy,
      root: allNew(first.value.ast),
    });
    const printMs = Math.round(performance.now() - printStarted);
    const code = codeOf(printed);
    // Every block goes through the printer, so the text is canonical, not the source. What
    // matters is that a whole page came back from a thread at this cap.
    const whole = printed.ok && Buffer.byteLength(printed.value.text) > source.length / 2;
    runs.push({ dialect, step: 'print', code: whole ? code : `${code}, short`, parseMs, printMs });
  }
  process.stdout.write(`${JSON.stringify({ mode: 'print', runs })}\n`);
  return runs.every((run) => run.code === 'ok');
}

async function flood(until: number): Promise<boolean> {
  const pages = DIALECTS.map((dialect) => {
    const source = honestPage(dialect);
    return { dialect, source, tree: allNew(parsed(source, dialect)) };
  });
  const codes = new Map<string, number>();
  const count = (code: string) => codes.set(code, (codes.get(code) ?? 0) + 1);
  let thrown = 0;

  const loop = async (organization: number, slot: number) => {
    for (let turn = slot; Date.now() < until; turn += 1) {
      const page = pages[turn % pages.length];
      if (page === undefined) return;
      const path = `flood/${organization}/${slot}`;
      try {
        const result =
          turn % 2 === 0
            ? await client.parse({
                tenant: tenant(organization),
                path,
                source: page.source,
                dialect: page.dialect,
                policy,
                priority: 'bulk',
              })
            : await client.print({
                tenant: tenant(organization),
                path,
                policy,
                root: page.tree,
                priority: 'bulk',
              });
        count(codeOf(result));
      } catch {
        // The client answers every host failure with a refusal, so a throw is our own bug.
        thrown += 1;
      }
    }
  };

  const loops = [];
  for (let organization = 1; organization <= ORGANIZATIONS; organization += 1) {
    for (let slot = 0; slot < IN_FLIGHT_PER_ORGANIZATION; slot += 1) {
      loops.push(loop(organization, slot));
    }
  }
  await Promise.all(loops);
  const summary = { mode: 'flood', thrown, codes: Object.fromEntries(codes) };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return thrown === 0;
}

const run =
  mode === 'print'
    ? printHonest()
    : mode === 'flood'
      ? flood(Date.now() + Number(seconds) * 1000)
      : Promise.reject(new Error(`unknown mode ${mode}`));
process.exitCode = (await run) ? 0 : 1;
