import type { Block, MailContent } from '../blocks.ts';
import {
  Body,
  Code,
  Container,
  Facts,
  Head,
  Heading,
  Html,
  Link,
  Preheader,
  Rule,
  Text,
} from './primitives.tsx';

function BlockView({ block }: { readonly block: Block }) {
  switch (block.type) {
    case 'heading':
      return <Heading>{block.text}</Heading>;
    case 'paragraph':
      return <Text>{block.text}</Text>;
    case 'code':
      return <Code code={block.code} />;
    // The raw URL is repeated under the link for clients that hide where a link goes.
    case 'action':
      return (
        <>
          <Text>
            <Link href={block.href}>{block.label}</Link>
          </Text>
          <Text small>{block.href.href}</Text>
        </>
      );
    case 'facts':
      return <Facts rows={block.rows} />;
    case 'rule':
      return <Rule />;
    case 'fineprint':
      return <Text small>{block.text}</Text>;
  }
}

export function MailDocument({ content }: { readonly content: MailContent }) {
  return (
    <Html>
      <Head title={content.subject} />
      <Body>
        <Preheader text={content.preheader} />
        <Container>
          {content.blocks.map((block, index) => (
            // Blocks never reorder, so the position is a stable key.
            <BlockView key={index} block={block} />
          ))}
        </Container>
      </Body>
    </Html>
  );
}
