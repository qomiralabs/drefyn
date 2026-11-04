import type { Block, FactRow, MailContent } from './blocks.ts';

const MEASURE = 72;
const FACT_MEASURE = 78;

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u)) {
    if (line !== '' && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

const paragraph = (text: string) => wrap(text, MEASURE).join('\n');

function facts(rows: readonly FactRow[]): string {
  const indent = Math.max(...rows.map((row) => row.label.length)) + 2;
  return rows
    .map((row) => {
      const [first = '', ...rest] = wrap(row.value, FACT_MEASURE - indent);
      const head = `${row.label}:`.padEnd(indent) + first;
      return [head, ...rest.map((line) => ' '.repeat(indent) + line)].join('\n');
    })
    .join('\n');
}

function block(b: Block): string | null {
  switch (b.type) {
    case 'heading':
      return b.text;
    case 'paragraph':
    case 'fineprint':
      return paragraph(b.text);
    // Alone on its line with no indent or grouping, so a long press takes the eight digits.
    case 'code':
      return `Your code:\n\n${b.code}\n\n${paragraph(b.note)}`;
    // The raw URL on its own line and never wrapped, or it breaks in a plain text client.
    case 'action':
      return [
        `${b.label}:`,
        b.href.href,
        ...(b.note === undefined ? [] : [paragraph(b.note)]),
      ].join('\n');
    case 'facts':
      return facts(b.rows);
    case 'rule':
      return null;
  }
}

export function renderText(content: MailContent): string {
  const parts = [`Drefyn: ${content.folio}`];
  for (const b of content.blocks) {
    const part = block(b);
    if (part !== null) parts.push(part);
  }
  parts.push(content.sender);
  return parts.join('\n\n') + '\n';
}
