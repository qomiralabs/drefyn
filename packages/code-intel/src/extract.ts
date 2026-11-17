import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import { Collector } from './collector.ts';
import type { CodeLanguage, LoadedGrammars } from './grammars.ts';
import { extractEcmascript } from './lang/ecmascript.ts';
import { extractGo } from './lang/go.ts';
import { extractPython } from './lang/python.ts';
import { extractRust } from './lang/rust.ts';
import type { ExtractOptions, FileExtraction } from './types.ts';

const EXTRACTORS: Readonly<Record<CodeLanguage, (root: Node, out: Collector) => void>> = {
  typescript: extractEcmascript,
  tsx: extractEcmascript,
  javascript: extractEcmascript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
};

// Pure over its inputs: the same source and grammars give the same answer, and nothing is
// read, written or logged. Time and memory are bounded by the thread it runs on, not here.
export function extractFile(
  language: CodeLanguage,
  source: string,
  grammars: LoadedGrammars,
  options: ExtractOptions = {},
): FileExtraction {
  const out = new Collector(language, options.path ?? '');
  const parser = new Parser();
  try {
    parser.setLanguage(grammars.languages[language]);
    const tree = parser.parse(source);
    if (tree === null) return { symbols: [], routes: [], partial: true };
    try {
      EXTRACTORS[language](tree.rootNode, out);
      return {
        symbols: out.symbols,
        routes: out.routes,
        partial: out.partial || tree.rootNode.hasError,
      };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
