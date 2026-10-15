export type Rule = 'dash' | 'co-author' | 'generated-with' | 'internal-path';

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

// Hyphen lookalikes (U+2010, U+2011) are folded to "-" so a trailer cannot slip past
// by swapping the hyphen for a character that renders the same.
const HYPHEN_LOOKALIKES = new RegExp(`[${String.fromCodePoint(0x2010, 0x2011)}]`, 'g');
const CO_AUTHOR_TRAILER = /^\s*co-authored-by\s*:/i;
const GENERATED_WITH = /generated\s+with/i;

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

export function checkFileContent(path: string, bytes: Uint8Array): Finding[] {
  if (isBinary(bytes)) return [];
  return dashFindings(path, new TextDecoder().decode(bytes));
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
    if (CO_AUTHOR_TRAILER.test(content.replace(HYPHEN_LOOKALIKES, '-'))) {
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
