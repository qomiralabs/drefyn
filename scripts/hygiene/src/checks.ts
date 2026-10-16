export type Rule = 'dash' | 'co-author' | 'generated-with' | 'internal-path' | 'encoding';

export interface Finding {
  rule: Rule;
  source: string;
  line?: number;
  column?: number;
  detail: string;
}

export interface DashHit {
  line: number;
  column: number;
  codePoint: 'U+2013' | 'U+2014';
}

const EN_DASH = 0x2013;
const EM_DASH = 0x2014;
const DASH_NAMES = { 'U+2013': 'en dash', 'U+2014': 'em dash' } as const;

// Git's own binary heuristic: a NUL in the first 8000 bytes.
const BINARY_SNIFF_BYTES = 8000;

// Characters that render like the hyphen in a trailer key, folded to "-", and invisible
// characters that could split the key, removed, so neither trick hides a trailer.
const HYPHEN_LOOKALIKES = /[\u{2010}\u{2011}\u{2012}\u{2212}\u{FE63}\u{FF0D}]/gu;
const ZERO_WIDTH = /[\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu;
const CO_AUTHOR_TRAILER = /^\s*co-authored-by\s*:/i;
// The tool attribution form only: the phrase opens the line, after nothing but emoji,
// markup or punctuation. "Types generated with openapi-typescript" stays legal.
const GENERATED_WITH =
  /^[\s\p{P}\p{S}\p{Extended_Pictographic}\u{FE0F}\u{200D}]*generated\s+with\b/iu;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const CP1252_DASHES = new Map([
  [0x96, 'byte 0x96 (Windows-1252 en dash)'],
  [0x97, 'byte 0x97 (Windows-1252 em dash)'],
]);

export function findDashes(text: string): DashHit[] {
  const hits: DashHit[] = [];
  let line = 1;
  let column = 0;
  for (const char of text) {
    if (char === '\n') {
      line += 1;
      column = 0;
      continue;
    }
    if (char === '\r') continue;
    column += 1;
    const code = char.codePointAt(0);
    if (code === EN_DASH) hits.push({ line, column, codePoint: 'U+2013' });
    else if (code === EM_DASH) hits.push({ line, column, codePoint: 'U+2014' });
  }
  return hits;
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function isInternalPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  const dirs = segments.slice(0, -1);
  if (dirs.includes('.internal') || dirs.includes('.claude')) return true;
  if (dirs.some((dir, i) => dir === 'docs' && dirs[i + 1] === 'internal')) return true;
  return name === 'implementation.md' || name === 'claude.md' || name.endsWith('.internal.md');
}

export function checkPath(path: string): Finding[] {
  const findings: Finding[] = [];
  if (isInternalPath(path)) {
    findings.push({
      rule: 'internal-path',
      source: path,
      detail: 'internal files must not be tracked',
    });
  }
  for (const hit of findDashes(path)) {
    findings.push({
      rule: 'dash',
      source: path,
      detail: `${hit.codePoint} ${DASH_NAMES[hit.codePoint]} in the file name`,
    });
  }
  return findings;
}

function dashFindings(source: string, text: string): Finding[] {
  return findDashes(text).map((hit) => ({
    rule: 'dash',
    source,
    line: hit.line,
    column: hit.column,
    detail: `${hit.codePoint} ${DASH_NAMES[hit.codePoint]}`,
  }));
}

function legacyDashFindings(path: string, bytes: Uint8Array): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) line += 1;
    const name = CP1252_DASHES.get(byte);
    if (name !== undefined) {
      findings.push({
        rule: 'dash',
        source: path,
        line,
        detail: `${name} in text that is not UTF-8`,
      });
    }
  }
  return findings;
}

export function checkFileContent(path: string, bytes: Uint8Array): Finding[] {
  if (isBinary(bytes)) return [];
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    // Decoding loosely would turn these bytes into U+FFFD and hide what they were.
    const legacy = legacyDashFindings(path, bytes);
    if (legacy.length > 0) return legacy;
    return [
      {
        rule: 'encoding',
        source: path,
        detail: 'not valid UTF-8, so it cannot be checked for dashes',
      },
    ];
  }
  return dashFindings(path, text);
}

// Used for commit messages and PR text, where attribution lines matter as much as dashes.
export function checkMessage(source: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    const line = index + 1;
    for (const finding of dashFindings(source, content)) {
      findings.push({ ...finding, line });
    }
    if (GENERATED_WITH.test(content)) {
      findings.push({
        rule: 'generated-with',
        source,
        line,
        detail: 'attribution line ("Generated with")',
      });
    }
    if (CO_AUTHOR_TRAILER.test(content.replace(ZERO_WIDTH, '').replace(HYPHEN_LOOKALIKES, '-'))) {
      findings.push({ rule: 'co-author', source, line, detail: 'co-author trailer' });
    }
  });
  return findings;
}

export function formatFinding(finding: Finding): string {
  let where = finding.source;
  if (finding.line !== undefined) where += `:${finding.line}`;
  if (finding.column !== undefined) where += `:${finding.column}`;
  return `${where}: ${finding.rule}: ${finding.detail}`;
}
