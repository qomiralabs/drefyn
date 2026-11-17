import { describe, expect, it } from 'vitest';
import { extractFile, loadGrammars } from '../src/index.ts';
import type { CodeLanguage, CodeRoute } from '../src/index.ts';
import { fixture } from './helpers.ts';

type Case = readonly [
  name: string,
  language: CodeLanguage,
  path: string,
  routes: readonly (readonly [method: string, route: string])[],
  framework: string,
  partial: boolean,
];

// partial is true where a route was there and could not be read: a computed path, or a mount
// that moves every route under it.
const CASES: readonly Case[] = [
  [
    'express',
    'typescript',
    'src/server.ts',
    [
      ['GET', '/health'],
      ['POST', '/users'],
      ['DELETE', '/users/:id'],
      ['ANY', '/proxy/*'],
    ],
    'express',
    true,
  ],
  [
    'fastify',
    'javascript',
    'server.js',
    [
      ['GET', '/items'],
      ['PUT', '/items/:id'],
      ['GET', '/items/:id/raw'],
      ['HEAD', '/items/:id/raw'],
    ],
    'fastify',
    false,
  ],
  ['hono', 'typescript', 'src/app.ts', [['PATCH', '/posts/:id']], 'hono', false],
  [
    'next-users-route',
    'typescript',
    'app/api/users/[id]/route.ts',
    [
      ['GET', '/api/users/[id]'],
      ['DELETE', '/api/users/[id]'],
    ],
    'next',
    false,
  ],
  [
    'next-about-route',
    'typescript',
    'src/app/(marketing)/about/route.ts',
    [['GET', '/about']],
    'next',
    false,
  ],
  [
    'flask_app',
    'python',
    'app.py',
    [
      ['GET', '/'],
      ['GET', '/users'],
      ['POST', '/users'],
      ['DELETE', '/users/<int:user_id>'],
    ],
    'flask',
    true,
  ],
  [
    'fastapi_app',
    'python',
    'main.py',
    [
      ['GET', '/items/{item_id}'],
      ['PUT', '/items/{item_id}'],
    ],
    'fastapi',
    false,
  ],
  [
    'urls',
    'python',
    'blog/urls.py',
    [
      ['ANY', 'articles/<int:year>/'],
      ['ANY', '^feed/$'],
    ],
    'django',
    false,
  ],
  [
    'nethttp',
    'go',
    'main.go',
    [
      ['GET', '/users/{id}'],
      ['ANY', '/static/'],
      ['ANY', '/health'],
    ],
    'net/http',
    true,
  ],
  [
    'gin',
    'go',
    'main.go',
    [
      ['GET', '/ping'],
      ['POST', '/users'],
    ],
    'gin',
    false,
  ],
  [
    'chi',
    'go',
    'routes.go',
    [
      ['GET', '/articles/{id}'],
      ['DELETE', '/articles/{id}'],
    ],
    'chi',
    false,
  ],
  [
    'axum',
    'rust',
    'src/app.rs',
    [
      ['GET', '/'],
      ['GET', '/users'],
      ['POST', '/users'],
      ['DELETE', '/items/{id}'],
    ],
    'axum',
    true,
  ],
  [
    'actix',
    'rust',
    'src/main.rs',
    [
      ['GET', '/hello/{name}'],
      ['POST', '/echo'],
    ],
    'actix-web',
    false,
  ],
];

const EXTENSION: Record<CodeLanguage, string> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  python: 'py',
  go: 'go',
  rust: 'rs',
};

describe('routes in framework fixtures', () => {
  it.each(CASES)('%s', async (name, language, path, routes, framework, partial) => {
    const source = fixture(`routes/${name}.${EXTENSION[language]}`);
    const result = extractFile(language, source, await loadGrammars(), { path });
    const expected: CodeRoute[] = routes.map(([method, route]) => ({
      path,
      method,
      route,
      framework,
    }));
    expect(result.routes).toEqual(expected);
    expect(result.partial).toBe(partial);
  });

  it('reads no route from a file that imports no framework', async () => {
    const source = "app.get('/x', handler);\nrouter.post('/y', handler);\n";
    const result = extractFile('typescript', source, await loadGrammars(), { path: 'a.ts' });
    expect(result.routes).toEqual([]);
    expect(result.partial).toBe(false);
  });

  it('needs the route file convention before reading Next handlers', async () => {
    const source = 'export function GET() { return new Response(); }\n';
    const result = extractFile('typescript', source, await loadGrammars(), { path: 'lib/get.ts' });
    expect(result.routes).toEqual([]);
  });
});
