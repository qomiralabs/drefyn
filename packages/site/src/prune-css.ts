// A small CSS reader, not a validator: enough to cut a stylesheet down to one page. Anything
// it cannot place stays, because a stray rule costs bytes and a lost one breaks the page.

interface Declaration {
  readonly kind: 'declaration';
  readonly text: string;
}

interface Statement {
  readonly kind: 'statement';
  readonly text: string;
}

interface Block {
  readonly kind: 'block';
  prelude: string;
  children: Item[];
}

type Item = Declaration | Statement | Block;

// Deep enough for any real sheet. Past it the input comes back whole, not a stack overflow.
const MAX_DEPTH = 64;

// Each nested function rescans its text, so depth times length is the real cost. No real
// selector is this long, and keeping one costs only its bytes.
const MAX_SELECTOR = 2_048;

// At rules whose children are rules for the same page. Others, such as @font-face and
// @keyframes, are opaque and stay as written.
const GROUPING = new Set(['@media', '@supports', '@layer', '@container', '@scope']);

// Functions that match only if one of their selectors can. :not and the like can match with
// their class absent, so they stay.
const NEEDS_A_BRANCH = new Set(['is', 'where', 'matches', 'has', '-webkit-any', '-moz-any']);

const DASHED = /(?<![\w-])--(?:[\w-]|[\u0080-￿]|\\.)+/g;
const CLASS_ATTRIBUTE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const VAR_IN_HTML = /var\(\s*(--[^\s,)]+)/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi, (whole, hex, dec, name) => {
    if (typeof name === 'string') return NAMED_ENTITIES[name] ?? whole;
    const point = hex === undefined ? Number(dec) : parseInt(String(hex), 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

function pageClasses(html: string): Set<string> {
  const classes = new Set<string>();
  for (const match of html.matchAll(CLASS_ATTRIBUTE)) {
    const value = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
    for (const name of value.split(/\s+/)) if (name !== '') classes.add(name);
  }
  return classes;
}

// Index just past the string or comment that starts at `at`.
function skipString(css: string, at: number): number {
  const quote = css[at];
  let i = at + 1;
  while (i < css.length && css[i] !== quote) i += css[i] === '\\' ? 2 : 1;
  return i + 1;
}

function skipComment(css: string, at: number): number {
  const end = css.indexOf('*/', at + 2);
  return end === -1 ? css.length : end + 2;
}

function isUnquotedUrl(css: string, open: number): boolean {
  if (css.slice(Math.max(0, open - 3), open).toLowerCase() !== 'url') return false;
  const next = /\S/.exec(css.slice(open + 1, open + 64))?.[0];
  return next !== '"' && next !== "'";
}

function pushLoose(into: Item[], raw: string): void {
  const text = raw.trim();
  if (text === '') return;
  into.push({ kind: text.startsWith('@') ? 'statement' : 'declaration', text });
}

// A stack rather than recursion, so the depth check is the only limit a sheet can hit.
function parse(css: string): Item[] | undefined {
  const root: Item[] = [];
  const stack: Item[][] = [root];
  let current = root;
  let buffer = '';
  let parens = 0;
  let i = 0;
  while (i < css.length) {
    const c = css.charAt(i);
    if (c === '/' && css[i + 1] === '*') {
      i = skipComment(css, i);
    } else if (c === '"' || c === "'") {
      const end = skipString(css, i);
      buffer += css.slice(i, end);
      i = end;
    } else if (c === '\\') {
      buffer += css.slice(i, i + 2);
      i += 2;
    } else if (c === '(' && isUnquotedUrl(css, i)) {
      const close = css.indexOf(')', i);
      const end = close === -1 ? css.length : close + 1;
      buffer += css.slice(i, end);
      i = end;
    } else if (c === '(' || (c === ')' && parens > 0)) {
      parens += c === '(' ? 1 : -1;
      buffer += c;
      i += 1;
    } else if (parens > 0) {
      buffer += c;
      i += 1;
    } else if (c === '{') {
      if (stack.length > MAX_DEPTH) return undefined;
      const block: Block = { kind: 'block', prelude: buffer.trim(), children: [] };
      current.push(block);
      current = block.children;
      stack.push(current);
      buffer = '';
      i += 1;
    } else if (c === '}') {
      pushLoose(current, buffer);
      buffer = '';
      if (stack.length > 1) stack.pop();
      current = stack.at(-1) ?? root;
      i += 1;
    } else if (c === ';') {
      pushLoose(current, buffer);
      buffer = '';
      i += 1;
    } else {
      buffer += c;
      i += 1;
    }
  }
  pushLoose(current, buffer);
  return root;
}

// Top level commas only, so :is(.a, .b) and [title="a,b"] stay in one piece.
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const c = list.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(list, i);
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function closing(selector: string, open: number): number {
  const pair = selector[open] === '(' ? ')' : ']';
  let depth = 0;
  let i = open;
  while (i < selector.length) {
    const c = selector.charAt(i);
    if (c === '"' || c === "'") {
      i = skipString(selector, i);
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === selector[open]) depth += 1;
    if (c === pair) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return selector.length;
}

function readIdent(selector: string, from: number): { name: string; end: number } {
  let name = '';
  let i = from;
  while (i < selector.length) {
    const c = selector.charAt(i);
    if (c === '\\') {
      const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(selector.slice(i + 1, i + 8));
      if (hex === null) {
        name += selector.charAt(i + 1);
        i += 2;
      } else {
        name += String.fromCodePoint(Math.min(parseInt(hex[0], 16), 0x10ffff));
        i += 1 + hex[0].length;
      }
    } else if (/[\w-]/.test(c) || c > '\u007f') {
      name += c;
      i += 1;
    } else {
      break;
    }
  }
  return { name, end: i };
}

function canMatch(selector: string, classes: ReadonlySet<string>, depth = 0): boolean {
  if (depth > MAX_DEPTH || selector.length > MAX_SELECTOR) return true;
  let i = 0;
  while (i < selector.length) {
    const c = selector.charAt(i);
    if (c === '\\') {
      i += 2;
    } else if (c === '"' || c === "'") {
      i = skipString(selector, i);
    } else if (c === '[' || c === '(') {
      i = closing(selector, i) + 1;
    } else if (c === '.') {
      const { name, end } = readIdent(selector, i + 1);
      if (name !== '' && !classes.has(name)) return false;
      i = end;
    } else if (c === ':') {
      const { name, end } = readIdent(selector, i + (selector[i + 1] === ':' ? 2 : 1));
      if (selector[end] !== '(') {
        i = Math.max(end, i + 1);
        continue;
      }
      const close = closing(selector, end);
      if (NEEDS_A_BRANCH.has(name.toLowerCase())) {
        const inner = splitList(selector.slice(end + 1, close));
        if (!inner.some((branch) => canMatch(branch, classes, depth + 1))) return false;
      }
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return true;
}

const atName = (prelude: string) => /^@[-\w]+/.exec(prelude)?.[0].toLowerCase() ?? '';

// Selector pass: drops rules no element can match and trims dead selectors from lists.
function dropDeadRules(items: readonly Item[], classes: ReadonlySet<string>): Item[] {
  const kept: Item[] = [];
  for (const item of items) {
    if (item.kind !== 'block') {
      kept.push(item);
    } else if (item.prelude.startsWith('@')) {
      if (GROUPING.has(atName(item.prelude))) {
        kept.push({ ...item, children: dropDeadRules(item.children, classes) });
      } else {
        kept.push(item);
      }
    } else {
      const live = splitList(item.prelude).filter((s) => canMatch(s, classes));
      if (live.length > 0) {
        const children = dropDeadRules(item.children, classes);
        kept.push({ kind: 'block', prelude: live.join(','), children });
      }
    }
  }
  return kept;
}

const isCustom = (text: string) => text.startsWith('--');
const customName = (text: string) => text.slice(0, text.indexOf(':')).trim();
const valueOf = (text: string) => text.slice(text.indexOf(':') + 1);
const dashedNames = (text: string) => text.match(DASHED) ?? [];
const registered = (item: Block) => atName(item.prelude) === '@property';

interface Usage {
  readonly roots: Set<string>;
  readonly defined: Map<string, Set<string>>;
}

function collectUsage(items: readonly Item[], usage: Usage, opaque = false): void {
  for (const item of items) {
    if (item.kind === 'statement') continue;
    if (item.kind === 'block') {
      if (registered(item)) continue;
      if (item.prelude.startsWith('@')) {
        for (const name of dashedNames(item.prelude)) usage.roots.add(name);
      }
      const inner = item.prelude.startsWith('@') && !GROUPING.has(atName(item.prelude));
      collectUsage(item.children, usage, opaque || inner);
    } else if (isCustom(item.text) && !opaque) {
      const name = customName(item.text);
      const refs = usage.defined.get(name) ?? new Set();
      for (const ref of dashedNames(valueOf(item.text))) refs.add(ref);
      usage.defined.set(name, refs);
    } else {
      for (const name of dashedNames(valueOf(item.text))) usage.roots.add(name);
    }
  }
}

// Properties reach each other through var(), so one used name can keep a chain alive.
function usedProperties({ roots, defined }: Usage): Set<string> {
  const used = new Set<string>();
  const pending = [...roots];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (used.has(name)) continue;
    used.add(name);
    pending.push(...(defined.get(name) ?? []));
  }
  return used;
}

function dropDeadProperties(items: readonly Item[], used: ReadonlySet<string>): Item[] {
  const kept: Item[] = [];
  for (const item of items) {
    if (item.kind === 'statement') {
      kept.push(item);
    } else if (item.kind === 'declaration') {
      if (!isCustom(item.text) || used.has(customName(item.text))) kept.push(item);
    } else if (registered(item)) {
      if (dashedNames(item.prelude).some((name) => used.has(name))) kept.push(item);
    } else if (item.prelude.startsWith('@') && !GROUPING.has(atName(item.prelude))) {
      kept.push(item);
    } else {
      const children = dropDeadProperties(item.children, used);
      if (children.length > 0) kept.push({ ...item, children });
    }
  }
  return kept;
}

function print(items: readonly Item[]): string {
  let out = '';
  items.forEach((item, index) => {
    if (item.kind === 'block') {
      out += `${item.prelude}{${print(item.children)}}`;
      return;
    }
    const needsEnd = item.kind === 'statement' || index < items.length - 1;
    out += needsEnd ? `${item.text};` : item.text;
  });
  return out;
}

export function pruneCss(html: string, css: string): string {
  const parsed = parse(css);
  if (parsed === undefined) return css;
  const live = dropDeadRules(parsed, pageClasses(html));
  const usage: Usage = { roots: new Set(), defined: new Map() };
  for (const match of html.matchAll(VAR_IN_HTML)) if (match[1]) usage.roots.add(match[1]);
  collectUsage(live, usage);
  return print(dropDeadProperties(live, usedProperties(usage)));
}
