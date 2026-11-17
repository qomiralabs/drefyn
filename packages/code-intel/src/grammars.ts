import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

export const CODE_LANGUAGES = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const require = createRequire(import.meta.url);

// The grammar packages' own prebuilt files. Their native bindings are never built or loaded.
export const GRAMMAR_FILES: Readonly<Record<CodeLanguage, string>> = {
  typescript: require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
  tsx: require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  javascript: require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'),
  python: require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
  go: require.resolve('tree-sitter-go/tree-sitter-go.wasm'),
  rust: require.resolve('tree-sitter-rust/tree-sitter-rust.wasm'),
};

export interface LoadedGrammars {
  readonly languages: Readonly<Record<CodeLanguage, Language>>;
}

let loading: Promise<LoadedGrammars> | undefined;

async function load(): Promise<LoadedGrammars> {
  await Parser.init();
  const entries = await Promise.all(
    CODE_LANGUAGES.map(
      async (language) =>
        [language, await Language.load(await readFile(GRAMMAR_FILES[language]))] as const,
    ),
  );
  return { languages: Object.fromEntries(entries) as Record<CodeLanguage, Language> };
}

// One load per thread: compiling the grammars costs far more than any file they parse.
export function loadGrammars(): Promise<LoadedGrammars> {
  loading ??= load();
  return loading;
}
