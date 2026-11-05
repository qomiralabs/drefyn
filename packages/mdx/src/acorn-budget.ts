import { Parser } from 'acorn';
import type { Options, Program } from 'acorn';
import acornJsx from 'acorn-jsx';

const JsxParser = Parser.extend(acornJsx());

// The MDX tokenizer reruns acorn from the start of an expression or ESM block at every `}` or
// blank line while the code stays unfinished, and an open comment or template stays
// unfinished for good. 50 KB of `}` after `{/*` takes over 20 s that way. The most any of
// 1,461 real pages asked for was 318 KB, on a 23 KB page; a retry costs up to about 6 us per
// byte handed over, so this caps the worst page at seconds.
const BASE_BYTES = 524_288;
const BYTES_PER_SOURCE_BYTE = 2;

export interface AcornBudget {
  readonly acorn: Pick<typeof Parser, 'parse' | 'parseExpressionAt'>;
  readonly exhausted: () => boolean;
}

// The tokenizer treats any error from acorn as "keep reading" until the end of the file, so a
// plain throw would not stop it. It does read `pos` off what it catches, and a throw from
// there leaves its catch block and ends the parse. The hostile tests fail if an upgrade
// changes that.
const STOP_PARSING = {
  get pos(): never {
    throw new Error('acorn budget spent');
  },
};

// Counts what acorn is handed and stops the parse when a page has spent its share.
export function acornBudget(sourceLength: number): AcornBudget {
  let left = BASE_BYTES + sourceLength * BYTES_PER_SOURCE_BYTE;
  const spend = (input: string) => {
    left -= input.length;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- see STOP_PARSING
    if (left < 0) throw STOP_PARSING;
  };
  return {
    acorn: {
      parse(input: string, options: Options): Program {
        spend(input);
        return JsxParser.parse(input, options);
      },
      parseExpressionAt(input: string, position: number, options: Options) {
        spend(input);
        return JsxParser.parseExpressionAt(input, position, options);
      },
    },
    exhausted: () => left < 0,
  };
}
