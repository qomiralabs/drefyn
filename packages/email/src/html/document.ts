import { createElement } from 'react';
import type { Block, MailContent } from '../blocks.ts';
import { OUTLOOK_CLOSE_TAG, OUTLOOK_HEAD_TAG, OUTLOOK_OPEN_TAG } from './outlook.ts';
import {
  Action,
  Article,
  Body,
  Code,
  Facts,
  Fineprint,
  Folio,
  Head,
  Heading,
  Html,
  Page,
  Paragraph,
  Preheader,
  Rule,
} from './primitives.ts';

function BlockView({ block }: { readonly block: Block }) {
  switch (block.type) {
    case 'heading':
      return createElement(Heading, { text: block.text });
    case 'paragraph':
      return createElement(Paragraph, { text: block.text });
    case 'code':
      return createElement(Code, { code: block.code, note: block.note });
    case 'action':
      return createElement(Action, {
        href: block.href,
        label: block.label,
        note: block.note,
        quiet: block.quiet,
      });
    case 'facts':
      return createElement(Facts, { rows: block.rows });
    case 'rule':
      return createElement(Rule, null);
    case 'fineprint':
      return createElement(Fineprint, { text: block.text });
  }
}

export function MailDocument({ content }: { readonly content: MailContent }) {
  return createElement(
    Html,
    null,
    createElement(Head, { title: content.subject, outlook: OUTLOOK_HEAD_TAG }),
    createElement(
      Body,
      null,
      createElement(Preheader, { text: content.preheader }),
      createElement(
        Article,
        { label: content.subject },
        createElement(
          Page,
          { open: OUTLOOK_OPEN_TAG, close: OUTLOOK_CLOSE_TAG },
          createElement(Folio, { text: content.folio }),
          // Blocks never reorder, so the position is a stable key.
          content.blocks.map((block, index) =>
            createElement(BlockView, { key: index, block: block }),
          ),
          createElement(Fineprint, { text: content.sender, top: 8 }),
        ),
      ),
    ),
  );
}
