// Just enough CSS reading for the generator's own output: rules, one level of @media, and
// declarations. Comments are dropped first.

export interface Rule {
  media: string | null;
  selector: string;
  declarations: Map<string, string>;
}

export function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  let media: string | null = null;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    const close = source.indexOf('}', i);
    if (close !== -1 && (open === -1 || close < open)) {
      // Closing an @media block.
      media = null;
      i = close + 1;
      continue;
    }
    if (open === -1) break;
    const prelude = source.slice(i, open).trim();
    if (prelude.startsWith('@media')) {
      media = prelude.slice('@media'.length).trim();
      i = open + 1;
      continue;
    }
    const end = source.indexOf('}', open);
    const body = source.slice(open + 1, end);
    const declarations = new Map<string, string>();
    for (const part of body.split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    rules.push({ media, selector: prelude, declarations });
    i = end + 1;
  }
  return rules;
}

export function findRule(rules: Rule[], selector: string, media: string | null = null): Rule {
  const rule = rules.find((r) => r.selector === selector && r.media === media);
  if (rule === undefined) throw new Error(`no rule ${selector} under ${media ?? 'no media'}`);
  return rule;
}
