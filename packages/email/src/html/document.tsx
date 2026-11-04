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
} from './primitives.tsx';

function BlockView({ block }: { readonly block: Block }) {
  switch (block.type) {
    case 'heading':
      return <Heading text={block.text} />;
    case 'paragraph':
      return <Paragraph text={block.text} />;
    case 'code':
      return <Code code={block.code} note={block.note} />;
    case 'action':
      return <Action href={block.href} label={block.label} note={block.note} quiet={block.quiet} />;
    case 'facts':
      return <Facts rows={block.rows} />;
    case 'rule':
      return <Rule />;
    case 'fineprint':
      return <Fineprint text={block.text} />;
  }
}

export function MailDocument({ content }: { readonly content: MailContent }) {
  return (
    <Html>
      <Head title={content.subject} outlook={OUTLOOK_HEAD_TAG} />
      <Body>
        <Preheader text={content.preheader} />
        <Article label={content.subject}>
          <Page open={OUTLOOK_OPEN_TAG} close={OUTLOOK_CLOSE_TAG}>
            <Folio text={content.folio} />
            {content.blocks.map((block, index) => (
              // Blocks never reorder, so the position is a stable key.
              <BlockView key={index} block={block} />
            ))}
            <Fineprint text={content.sender} top={8} />
          </Page>
        </Article>
      </Body>
    </Html>
  );
}
