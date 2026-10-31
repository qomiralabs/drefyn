import type { Block, MailContent } from './blocks.ts';

const RULE = '-'.repeat(40);

function block(b: Block): string {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
    case 'fineprint':
      return b.text;
    case 'code':
      return b.code;
    // The raw URL on its own line, so it survives clients that strip links.
    case 'action':
      return `${b.label}:\n${b.href.href}`;
    case 'facts':
      return b.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    case 'rule':
      return RULE;
  }
}

export function renderText(content: MailContent): string {
  return content.blocks.map(block).join('\n\n') + '\n';
}
