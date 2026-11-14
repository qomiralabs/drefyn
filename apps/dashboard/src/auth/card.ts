// What the small card on the signed out pages says. One object, so a real customer quote can
// replace the product line later without touching the layout. Nothing here may be invented:
// a quote ships only with the person's consent.

export interface CardLink {
  readonly href: string;
  readonly label: string;
}

export interface CardLine {
  readonly kind: 'line';
  readonly line: string;
  readonly support: string;
  readonly link?: CardLink | undefined;
}

export interface CardQuote {
  readonly kind: 'quote';
  readonly quote: string;
  readonly name: string;
  readonly handle: string;
  // A same origin path or an https URL the CSP allows.
  readonly avatar: string;
  readonly link?: CardLink | undefined;
}

export type CardContent = CardLine | CardQuote;

export const AUTH_CARD: CardContent = {
  kind: 'line',
  line: 'Publish your docs, content and status page from one place.',
  support: 'Open source, on one account and one plan.',
};

export const cardName = (content: CardContent): string =>
  content.kind === 'line' ? 'About Drefyn' : `What ${content.name} says about Drefyn`;
