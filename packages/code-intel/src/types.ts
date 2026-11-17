import type { CodeLanguage } from './grammars.ts';

export type SymbolKind =
  'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'struct' | 'enum' | 'trait';

export interface CodeSymbol {
  readonly language: CodeLanguage;
  readonly path: string;
  // Methods and items in inline modules carry their owner: `Client.list`, `auth.token`.
  readonly name: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  // The declaration head with whitespace collapsed: never a body, never a constant's value.
  readonly signature: string;
  readonly doc: string | null;
  // 1 based, at the declaration itself and not its decorators or attributes.
  readonly startLine: number;
}

export interface CodeRoute {
  readonly path: string;
  // Upper case, or ANY where the framework takes every method.
  readonly method: string;
  // As the framework writes it: `/users/:id`, `/users/{id}`, `/users/<int:id>`.
  readonly route: string;
  readonly framework: string;
}

export interface FileExtraction {
  readonly symbols: readonly CodeSymbol[];
  readonly routes: readonly CodeRoute[];
  // True when the file had syntax errors or held something that was not followed: a computed
  // route, a router mount, a dynamic __all__, an item macro.
  readonly partial: boolean;
}

export interface ExtractOptions {
  // The file's path in its repository. Copied onto every symbol and route, and read for route
  // conventions that live in the path, such as Next's app/**/route.ts.
  readonly path?: string;
}
