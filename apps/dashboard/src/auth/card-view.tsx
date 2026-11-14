import type { ReactNode } from 'react';
import { cardName, type CardContent, type CardLink } from './card.ts';

function Link({ link }: { link: CardLink | undefined }): ReactNode {
  if (link === undefined) return null;
  return (
    <a className="auth-card-link" href={link.href}>
      {link.label}
    </a>
  );
}

// The only thing it may hold that takes focus is the optional link, so it adds no Tab stop
// to the form unless someone gave it somewhere to go.
export function AuthCard({ content }: { content: CardContent }): ReactNode {
  if (content.kind === 'line') {
    return (
      <aside className="auth-card" aria-label={cardName(content)}>
        <p className="auth-card-line">{content.line}</p>
        <p className="auth-card-support">{content.support}</p>
        <Link link={content.link} />
      </aside>
    );
  }
  return (
    <aside className="auth-card" aria-label={cardName(content)}>
      <figure className="auth-card-figure">
        <blockquote className="auth-card-line">
          <p>{content.quote}</p>
        </blockquote>
        <figcaption className="auth-card-person">
          {/* The name sits beside it, so the picture adds nothing to read. Lazy, because the panel
              is not drawn on a phone. */}
          <img src={content.avatar} alt="" width="32" height="32" loading="lazy" />
          <span>
            <span className="auth-card-name">{content.name}</span>
            <span className="auth-card-handle">{content.handle}</span>
          </span>
        </figcaption>
      </figure>
      <Link link={content.link} />
    </aside>
  );
}
