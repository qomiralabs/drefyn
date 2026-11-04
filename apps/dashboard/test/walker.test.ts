import { describe, expect, it } from 'vitest';
import { checkSource, checkTree, sourceFiles } from './support/walker.ts';

const PAGE = 'src/app/[org]/page.tsx';
const ACTIONS = 'src/server/thing-actions.ts';
const ROUTE = 'src/app/api/thing/route.ts';
const GUARD = "import { guardOrganization } from '../../server/guard.ts';\n";
const WRAP = "import { publicAction, orgAction } from '../server/actions.ts';\n";
const WRAP_ROUTE = "import { publicRoute } from '../../../server/actions.ts';\n";

const problems = (path: string, text: string) => checkSource(path, text).map((f) => f.problem);

describe('pages and layouts', () => {
  it.each([
    ['await first', 'export default async function P() { await guardOrganization(o); return 1; }'],
    [
      'params first',
      `export default async function P({ params }) {
        const { org } = await params;
        const found = await guardOrganization(org);
        return found;
      }`,
    ],
    [
      'nested params',
      'export default async function P({ params }) { await guardOrganization((await params).org); }',
    ],
    [
      'through a helper',
      `async function load(params) {
        const { org } = await params;
        await guardOrganization(org);
        return 1;
      }
      export default async function P({ params }) { const x = await load(params); return x; }
      export async function generateMetadata({ params }) {
        return { title: (await load(params)).title };
      }`,
    ],
    [
      'a default export by name',
      'async function P() { await guardOrganization(o); }\nexport default P;',
    ],
    [
      'an arrow generateMetadata',
      `export const generateMetadata = async () => { await guardOrganization(o); };
       export default async function P() { await guardOrganization(o); }`,
    ],
  ])('passes %s', (_name, body) => {
    expect(problems(PAGE, GUARD + body)).toEqual([]);
  });

  it.each([
    ['no guard', 'export default async function P() { return 1; }'],
    ['a sync page', 'export default function P() { return 1; }'],
    ['an unawaited guard', 'export default async function P() { guardOrganization(o); }'],
    [
      'work before the guard',
      'export default async function P() { track(); await guardOrganization(o); }',
    ],
    [
      'an await before the guard',
      'export default async function P() { await load(); await guardOrganization(o); }',
    ],
    [
      'a guard behind a condition',
      'export default async function P() { if (x) { await guardOrganization(o); } }',
    ],
    [
      'a call in the same expression',
      'export default async function P() { const a = other() + (await guardOrganization(o)); }',
    ],
    [
      'a call in the guard arguments',
      'export default async function P() { await guardOrganization(await other()); }',
    ],
    ['a wrapped default export', 'export default wrap(async () => 1);'],
    ['a default export of an import', "import P from './p.tsx';\nexport default P;"],
    ['an unknown helper', 'export default async function P() { await load(); }'],
    [
      'helpers that loop',
      `async function a() { await b(); }
       async function b() { await a(); }
       export default async function P() { await a(); }`,
    ],
  ])('fails on %s', (_name, body) => {
    expect(problems(PAGE, GUARD + body)).toEqual(['guard_missing']);
  });

  it('fails on a generateMetadata without the guard, even with a guarded page', () => {
    const text = `${GUARD}export default async function P() { await guardOrganization(o); }
      export async function generateMetadata() { return {}; }`;
    expect(problems(PAGE, text)).toEqual(['guard_missing']);
  });

  it('fails on a re exported generateMetadata and on export star', () => {
    const page = 'export default async function P() { await guardOrganization(o); }\n';
    expect(problems(PAGE, `${GUARD}${page}export { generateMetadata } from './m.ts';`)).toEqual([
      'guard_missing',
    ]);
    expect(problems(PAGE, `${GUARD}${page}export * from './m.ts';`)).toEqual(['guard_missing']);
  });

  it('fails on a re exported default', () => {
    expect(problems(PAGE, "export { default } from './p.tsx';")).toEqual(['guard_missing']);
  });

  it('fails on a guard of the same name from elsewhere', () => {
    const text =
      "import { guardOrganization } from './fake.ts';\nexport default async function P() { await guardOrganization(o); }";
    expect(problems(PAGE, text)).toEqual(['guard_missing']);
  });

  it('fails on a local guard that shadows the import', () => {
    const text = `${GUARD}export default async function P() {
      const guardOrganization = async () => 1;
      await guardOrganization();
    }`;
    expect(problems(PAGE, text)).toEqual(['guard_missing']);
  });

  it('fails on another guard renamed to the one the path needs', () => {
    const text = `import { guardPublic as guardOrganization } from '../../server/guard.ts';
      export default async function P() { await guardOrganization(); }`;
    expect(problems(PAGE, text)).toEqual(['guard_missing']);
  });

  it('accepts a renamed guard of the right kind', () => {
    const text = `import { guardOrganization as guard } from '../../server/guard.ts';
      export default async function P() { await guard(o); }`;
    expect(problems(PAGE, text)).toEqual([]);
  });

  it('checks layouts, templates and default slots', () => {
    const bad = 'export default async function L() { return 1; }';
    for (const name of ['layout', 'template', 'default']) {
      expect(problems(`src/app/[org]/x/${name}.tsx`, bad), name).toEqual(['guard_missing']);
    }
  });

  it('leaves the root layout and the not found page alone, by exact path', () => {
    const plain = 'export default function L() { return 1; }';
    expect(problems('src/app/layout.tsx', plain)).toEqual([]);
    expect(problems('src/app/not-found.tsx', plain)).toEqual([]);
    expect(problems('src/app/[org]/not-found.tsx', plain)).toEqual([]);
  });
});

describe('which guard each path takes', () => {
  const using = (name: string) =>
    `import { ${name} } from '../server/guard.ts';
     export default async function P() { await ${name}(); }`;

  it('takes guardSignedIn at the root only', () => {
    expect(problems('src/app/page.tsx', using('guardSignedIn'))).toEqual([]);
    expect(problems('src/app/page.tsx', using('guardPublic'))).toEqual(['guard_missing']);
    expect(problems('src/app/page.tsx', using('guardOrganization'))).toEqual(['guard_missing']);
    expect(problems(PAGE, using('guardSignedIn'))).toEqual(['guard_missing']);
  });

  it('takes guardPublic only on the allow list', () => {
    expect(problems('src/app/bundle-baseline/page.tsx', using('guardPublic'))).toEqual([]);
    expect(problems('src/app/somewhere/page.tsx', using('guardPublic'))).toEqual(['public_guard']);
    expect(problems(PAGE, using('guardPublic'))).toEqual(['guard_missing']);
  });

  it('refuses guardPublic on a path that only looks like the allowed one', () => {
    for (const path of [
      'src/app/bundle-baseline/x/page.tsx',
      'src/app/[org]/bundle-baseline/page.tsx',
    ]) {
      expect(problems(path, using('guardPublic')).length, path).toBe(1);
    }
  });

  it('asks for a guard on a page outside any list', () => {
    expect(problems('src/app/somewhere/page.tsx', using('guardOrganization'))).toEqual([]);
    expect(problems('src/app/somewhere/page.tsx', 'export default async () => 1;')).toEqual([
      'guard_missing',
    ]);
  });
});

describe("'use server' files", () => {
  const file = (body: string) => `'use server';\n${WRAP}${body}`;

  it.each([
    ['a const', 'export const a = publicAction(async () => 1);'],
    ['a default', 'export default orgAction(async () => 1);'],
    ['a named list', 'const a = publicAction(async () => 1);\nexport { a };'],
    ['a rename', 'const a = publicAction(async () => 1);\nexport { a as b };'],
    ['a default by name', 'const a = publicAction(async () => 1);\nexport default a;'],
    ['a type', 'export type A = number;\nexport interface B { c: 1 }'],
  ])('passes %s', (_name, body) => {
    expect(problems(ACTIONS, file(body))).toEqual([]);
  });

  it.each([
    ['an async function', 'export async function a() { return 1; }'],
    ['an arrow', 'export const a = async () => 1;'],
    ['a default function', 'export default async function a() { return 1; }'],
    ['a default arrow', 'export default async () => 1;'],
    ['a named list of a bare function', 'async function a() {}\nexport { a };'],
    ['a default by name of a bare function', 'async function a() {}\nexport default a;'],
    ['a let', 'export let a = publicAction(async () => 1);'],
    ['a reassigned alias', 'const a = publicAction(async () => 1);\nconst b = a;\nexport { b };'],
    ['a re export', "export { a } from './other.ts';"],
    ['a default re export', "export { default } from './other.ts';"],
    ['export star', "export * from './other.ts';"],
    ['an unknown wrapper', 'export const a = trusted(async () => 1);'],
    ['a member call', 'export const a = lib.publicAction(async () => 1);'],
    ['a wrapped wrapper', 'export const a = trusted(publicAction(async () => 1));'],
    ['a route wrapper', 'export const a = publicRoute(async () => 1);'],
  ])('fails on %s', (_name, body) => {
    expect(problems(ACTIONS, file(body))).toEqual(['action_unwrapped']);
  });

  it('fails on a wrapper of the same name from elsewhere', () => {
    const text = `'use server';
      import { publicAction } from './fake.ts';
      export const a = publicAction(async () => 1);`;
    expect(problems(ACTIONS, text)).toEqual(['action_unwrapped']);
  });

  it('fails on a local wrapper that shadows nothing', () => {
    const text = `'use server';
      const publicAction = (f) => f;
      export const a = publicAction(async () => 1);`;
    expect(problems(ACTIONS, text)).toEqual(['action_unwrapped']);
  });

  it('accepts a renamed wrapper', () => {
    const text = `'use server';
      import { orgAction as act } from '../server/actions.ts';
      export const a = act(async () => 1);`;
    expect(problems(ACTIONS, text)).toEqual([]);
  });

  it('applies wherever the directive is, pages and helpers alike', () => {
    expect(
      problems('src/shell/x.ts', "'use server';\nexport async function a() { return 1; }"),
    ).toEqual(['action_unwrapped']);
  });

  it('does not read the words in a comment or a string as a directive', () => {
    const text = `// 'use server'
      const note = 'use server';
      export async function a() { return note; }`;
    expect(problems('src/shell/x.ts', text)).toEqual([]);
  });
});

describe("inline 'use server'", () => {
  it.each([
    ['a function', "export function C() { async function a() { 'use server'; } return a; }"],
    ['an arrow', "export const f = async () => { 'use server'; return 1; };"],
    ['a double quoted directive', 'export function C() { async function a() { "use server"; } }'],
    ['a method', "export const o = { async a() { 'use server'; } };"],
    ['inside a use client file', "'use client';\nexport const f = async () => { 'use server'; };"],
    [
      'after another directive',
      "export const f = async () => { 'use strict'; 'use server'; return 1; };",
    ],
  ])('fails in %s', (_name, body) => {
    expect(problems('src/shell/thing.tsx', body)).toEqual(['inline_use_server']);
  });

  it('fails inside a page, on top of a good guard', () => {
    const text = `${GUARD}export default async function P() {
      await guardOrganization(o);
      async function a() { 'use server'; }
      return a;
    }`;
    expect(problems(PAGE, text)).toEqual(['inline_use_server']);
  });

  it('fails inside a wrapped action', () => {
    const text = `'use server';\n${WRAP}export const a = publicAction(async () => { 'use server'; });`;
    expect(problems(ACTIONS, text)).toEqual(['inline_use_server']);
  });

  it('passes the same string as ordinary code', () => {
    expect(
      problems('src/shell/x.ts', "export function f() { const a = 1; 'use server'; return a; }"),
    ).toEqual([]);
  });
});

describe('route handlers', () => {
  it.each([
    ['a GET', 'export async function GET() { return new Response(); }'],
    ['HEAD and OPTIONS', 'export const HEAD = async () => 1;\nexport const OPTIONS = HEAD;'],
    ['a wrapped POST', 'export const POST = publicRoute(async () => new Response());'],
    [
      'a wrapped POST by name',
      'const handler = publicRoute(async () => new Response());\nexport { handler as POST };',
    ],
  ])('passes %s', (_name, body) => {
    expect(problems(ROUTE, WRAP_ROUTE + body)).toEqual([]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('fails on a bare %s', (method) => {
    expect(
      problems(ROUTE, `${WRAP_ROUTE}export async function ${method}() { return new Response(); }`),
    ).toEqual(['route_unwrapped']);
  });

  it.each([
    ['an arrow', 'export const POST = async () => new Response();'],
    ['a named list', 'async function h() {}\nexport { h as POST };'],
    ['a re export', "export { POST } from './other.ts';"],
    ['a renamed re export', "export { handler as POST } from './other.ts';"],
    ['export star', "export * from './other.ts';"],
    ['an action wrapper', 'export const POST = publicAction(async () => new Response());'],
    ['an alias', 'const a = publicRoute(async () => 1);\nconst b = a;\nexport { b as POST };'],
    ['a default export', 'export default async function POST() {}'],
  ])('fails on %s', (_name, body) => {
    expect(problems(ROUTE, WRAP_ROUTE + body)).toEqual(['route_unwrapped']);
  });

  it('ignores files that are only named like a route outside src/app', () => {
    expect(problems('src/shell/route.ts', 'export async function POST() {}')).toEqual([]);
  });
});

describe('a finding', () => {
  it('names the file, the line and the export', () => {
    expect(
      checkSource(ACTIONS, "'use server';\n\nexport async function send() { return 1; }"),
    ).toEqual([{ path: ACTIONS, line: 3, name: 'send', problem: 'action_unwrapped' }]);
  });
});

describe('the real tree', () => {
  it('holds to every rule', () => {
    expect(checkTree(new URL('..', import.meta.url))).toEqual([]);
  });

  it('read files, so a walker that reads nothing cannot pass', () => {
    expect(sourceFiles(new URL('..', import.meta.url)).length).toBeGreaterThan(30);
  });
});

describe('the session guard', () => {
  it('is refused on pages: it is for account level actions', () => {
    const text = `import { guardSession } from '../server/guard.ts';
      export default async function P() { await guardSession(); }`;
    expect(problems('src/app/page.tsx', text)).toEqual(['guard_missing']);
  });
});
