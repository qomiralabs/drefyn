// postcss exports this path and ships no types for it.
declare module 'postcss/lib/tokenize' {
  import type { Input } from 'postcss';

  type Token = readonly [type: string, text: string, ...rest: number[]];

  export default function tokenizer(input: Input): {
    endOfFile(): boolean;
    nextToken(): Token | undefined;
  };
}
