// Mail clients drop most CSS, so everything here is tables and inline styles, with a class
// on each node only so the dark rules can reach it. Paper, hairlines and type do the
// structure: there is no card, no filled shape and nothing an inverting client can break.
import { createElement, Fragment, type CSSProperties, type ReactNode } from 'react';
import type { FactRow } from '../blocks.ts';
import { MAIL_PALETTE, MONO, SANS } from './palette.ts';
import { MAIL_CSS } from './styles.ts';

const L = MAIL_PALETTE.light;

const TRACKED = '0.12em';

function type(size: number, lineHeight: string, color: string): CSSProperties {
  return {
    margin: 0,
    fontFamily: SANS,
    fontSize: `${size}px`,
    lineHeight,
    color,
  };
}

const label: CSSProperties = {
  ...type(12, '1.2', L.secondary),
  fontFamily: MONO,
  fontWeight: 500,
  letterSpacing: TRACKED,
  textTransform: 'uppercase',
};

const small = type(13, '1.45', L.secondary);
const note = { ...type(14, '1.55', L.secondary), fontVariantNumeric: 'tabular-nums' };
const table = { role: 'presentation', cellPadding: 0, cellSpacing: 0, border: 0 } as const;

// One table row in the column, spaced from the row above.
function Row({ top, children }: { readonly top: number; readonly children?: ReactNode }) {
  return createElement(
    'tr',
    null,
    createElement('td', { style: { paddingTop: `${top}px` } }, children),
  );
}

export function Html({ children }: { readonly children?: ReactNode }) {
  // Word reads the o: namespace, and React has no prop name for it.
  const attributes = {
    lang: 'en',
    dir: 'ltr',
    xmlns: 'http://www.w3.org/1999/xhtml',
    'xmlns:o': 'urn:schemas-microsoft-com:office:office',
  };
  return createElement('html', attributes, children);
}

export function Head({ title, outlook }: { readonly title: string; readonly outlook: string }) {
  return createElement(
    'head',
    null,
    createElement('meta', { charSet: 'utf-8' }),
    createElement('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' }),
    createElement('meta', { name: 'x-apple-disable-message-reformatting' }),
    createElement('meta', {
      name: 'format-detection',
      content: 'telephone=no,date=no,address=no,email=no,url=no',
    }),
    createElement('meta', { name: 'color-scheme', content: 'light dark' }),
    createElement('meta', { name: 'supported-color-schemes', content: 'light dark' }),
    createElement('title', null, title),
    createElement(outlook),
    createElement('style', null, MAIL_CSS),
  );
}

export function Body({ children }: { readonly children?: ReactNode }) {
  return createElement(
    'body',
    { className: 'dr-bg', style: { margin: 0, padding: 0, backgroundColor: L.ground } },
    children,
  );
}

// Filler stops clients pulling body text into the inbox line after the preheader.
const PREHEADER_FILL = ' ﻿͏'.repeat(40);

export function Preheader({ text }: { readonly text: string }) {
  return createElement(
    'div',
    {
      style: {
        display: 'none',
        maxHeight: 0,
        maxWidth: 0,
        overflow: 'hidden',
        opacity: 0,
        msoHide: 'all',
      } as CSSProperties,
    },
    text,
    PREHEADER_FILL,
  );
}

// The article role is the Email Markup Consortium pattern: a mail body always sits inside the
// client's own main, so it must not bring another.
export function Article({
  label: name,
  children,
}: {
  readonly label: string;
  readonly children?: ReactNode;
}) {
  return createElement(
    'div',
    {
      role: 'article',
      'aria-roledescription': 'email',
      'aria-label': name,
      lang: 'en',
      dir: 'ltr',
    },
    children,
  );
}

export function Page({
  open,
  close,
  children,
}: {
  readonly open: string;
  readonly close: string;
  readonly children?: ReactNode;
}) {
  // bgColor is a real attribute that the React types leave out.
  const paper = { bgColor: L.ground };
  return createElement(
    'table',
    {
      ...table,
      ...paper,
      className: 'dr-bg',
      width: '100%',
      style: { width: '100%', backgroundColor: L.ground },
    },
    createElement(
      'tbody',
      null,
      createElement(
        'tr',
        null,
        createElement(
          'td',
          { align: 'center', className: 'dr-wrap', style: { padding: '40px 24px 48px' } },
          createElement(open),
          createElement(
            'table',
            {
              ...table,
              width: '100%',
              style: { width: '100%', maxWidth: '560px', textAlign: 'left' },
            },
            createElement('tbody', null, children),
          ),
          createElement(close),
        ),
      ),
    ),
  );
}

// The running head of a technical publication: the name as a label, not the wordmark, and
// what this mail is. It needs no image, so it survives every client.
export function Folio({ text }: { readonly text: string }) {
  return createElement(
    'tr',
    null,
    createElement(
      'td',
      {
        className: 'dr-rule',
        style: { paddingBottom: '16px', borderBottom: `1px solid ${L.rule}` },
      },
      createElement(
        'table',
        { ...table, width: '100%' },
        createElement(
          'tbody',
          null,
          createElement(
            'tr',
            null,
            createElement(
              'td',
              { className: 'dr-ink dr-mono dr-folio', style: { ...label, color: L.ink } },
              'Drefyn',
            ),
            createElement(
              'td',
              {
                className: 'dr-sec dr-mono dr-folio-label',
                align: 'right',
                style: { ...label, textAlign: 'right' },
              },
              text,
            ),
          ),
        ),
      ),
    ),
  );
}

export function Heading({ text }: { readonly text: string }) {
  return createElement(
    Row,
    { top: 40 },
    createElement(
      'h1',
      {
        className: 'dr-ink dr-h1',
        style: { ...type(28, '1.2', L.ink), fontWeight: 600, letterSpacing: '-0.015em' },
      },
      text,
    ),
  );
}

export function Paragraph({ text }: { readonly text: string }) {
  return createElement(
    Row,
    { top: 16 },
    createElement('p', { className: 'dr-body', style: type(16, '1.6', L.body) }, text),
  );
}

// The gap after the fourth digit is letter spacing, not a space, so a double click, a copy
// and iOS code autofill all take eight digits.
export function Code({ code, note: expiry }: { readonly code: string; readonly note: string }) {
  return createElement(
    Fragment,
    null,
    createElement(
      Row,
      { top: 32 },
      createElement(
        'table',
        { ...table },
        createElement(
          'tbody',
          null,
          createElement(
            'tr',
            null,
            createElement(
              'td',
              {
                className: 'dr-gutter',
                style: { borderLeft: `2px solid ${L.ink}`, padding: '4px 0 4px 16px' },
              },
              createElement('p', { className: 'dr-sec dr-mono', style: label }, 'Your code'),
              createElement(
                'p',
                {
                  className: 'dr-ink dr-code dr-mono',
                  style: {
                    ...type(36, '1.25', L.ink),
                    fontFamily: MONO,
                    fontWeight: 500,
                    letterSpacing: '0.04em',
                    fontVariantNumeric: 'tabular-nums',
                    paddingTop: '8px',
                    WebkitUserSelect: 'all',
                    userSelect: 'all',
                  },
                },
                code.slice(0, 3),
                createElement('span', { style: { letterSpacing: '0.5em' } }, code.slice(3, 4)),
                code.slice(4),
              ),
            ),
          ),
        ),
      ),
    ),
    createElement(
      Row,
      { top: 12 },
      createElement('p', { className: 'dr-sec', style: note }, expiry),
    ),
  );
}

export function Action({
  href,
  label: text,
  note: detail,
  quiet = false,
}: {
  readonly href: URL;
  readonly label: string;
  readonly note?: string | undefined;
  readonly quiet: boolean | undefined;
}) {
  return createElement(
    Row,
    { top: quiet ? 12 : 24 },
    createElement(
      'p',
      {
        className: 'dr-body',
        style: quiet ? { ...small, lineHeight: '24px' } : type(16, '1.6', L.body),
      },
      createElement(
        'a',
        {
          href: href.href,
          className: 'dr-link',
          style: {
            color: L.accent,
            fontWeight: 500,
            textDecoration: 'underline',
            textUnderlineOffset: '3px',
          },
        },
        text,
      ),
    ),
    detail === undefined
      ? null
      : createElement('p', { className: 'dr-sec', style: { ...note, paddingTop: '4px' } }, detail),
    // The full address, so a careful reader can check the host before opening it.
    createElement(
      'p',
      {
        className: 'dr-sec dr-mono',
        style: {
          ...small,
          fontFamily: MONO,
          paddingTop: quiet ? '4px' : '8px',
          wordBreak: 'break-all',
        },
      },
      href.href,
    ),
  );
}

export function Facts({ rows }: { readonly rows: readonly FactRow[] }) {
  const edge = `1px solid ${L.rule}`;
  return createElement(
    Row,
    { top: 24 },
    createElement(
      'table',
      {
        cellPadding: 0,
        cellSpacing: 0,
        border: 0,
        width: '100%',
        style: { borderCollapse: 'collapse', width: '100%' },
      },
      createElement(
        'tbody',
        null,
        rows.map((row, index) => {
          const lines: CSSProperties = {
            borderTop: edge,
            ...(index === rows.length - 1 ? { borderBottom: edge } : {}),
            verticalAlign: 'top',
          };
          return createElement(
            'tr',
            { key: row.label },
            createElement(
              'th',
              {
                scope: 'row',
                className: 'dr-sec dr-rule dr-mono',
                style: {
                  ...label,
                  ...lines,
                  padding: '10px 16px 10px 0',
                  width: '112px',
                  textAlign: 'left',
                  lineHeight: '24px',
                },
              },
              row.label,
            ),
            createElement(
              'td',
              {
                className: 'dr-body dr-rule',
                style: {
                  ...type(15, '24px', L.body),
                  ...lines,
                  padding: '10px 0',
                  fontVariantNumeric: 'tabular-nums',
                  overflowWrap: 'anywhere',
                },
              },
              row.value,
            ),
          );
        }),
      ),
    ),
  );
}

export function Rule() {
  return createElement(
    Row,
    { top: 40 },
    createElement(
      'table',
      { ...table, width: '100%' },
      createElement(
        'tbody',
        null,
        createElement(
          'tr',
          null,
          createElement(
            'td',
            {
              className: 'dr-rule dr-divider',
              style: {
                borderTop: `1px solid ${L.rule}`,
                fontSize: 0,
                lineHeight: 0,
                height: '1px',
              },
            },
            '\u00a0',
          ),
        ),
      ),
    ),
  );
}

export function Fineprint({ text, top = 24 }: { readonly text: string; readonly top?: number }) {
  return createElement(
    Row,
    { top: top },
    createElement('p', { className: 'dr-sec', style: small }, text),
  );
}
