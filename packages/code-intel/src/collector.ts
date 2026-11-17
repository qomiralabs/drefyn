import type { Node } from 'web-tree-sitter';
import type { CodeLanguage } from './grammars.ts';
import type { CodeRoute, CodeSymbol, SymbolKind } from './types.ts';

export interface SymbolDraft {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly signature: string;
  readonly doc: string | null;
  readonly node: Node;
}

export class Collector {
  readonly symbols: CodeSymbol[] = [];
  readonly routes: CodeRoute[] = [];
  partial = false;

  readonly language: CodeLanguage;
  readonly path: string;

  constructor(language: CodeLanguage, path: string) {
    this.language = language;
    this.path = path;
  }

  symbol(draft: SymbolDraft): CodeSymbol {
    const symbol: CodeSymbol = {
      language: this.language,
      path: this.path,
      name: draft.name,
      kind: draft.kind,
      exported: draft.exported,
      signature: draft.signature,
      doc: draft.doc,
      startLine: draft.node.startPosition.row + 1,
    };
    this.symbols.push(symbol);
    return symbol;
  }

  route(method: string, route: string, framework: string): void {
    this.routes.push({ path: this.path, method: method.toUpperCase(), route, framework });
  }
}
