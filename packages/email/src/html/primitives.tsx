// Mail clients drop most CSS, so everything here is tables and inline styles, with a class
// on each node only so the dark rules can reach it. Paper, hairlines and type do the
// structure: there is no card, no filled shape and nothing an inverting client can break.
import { createElement, type CSSProperties, type ReactNode } from 'react';
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
function Row({ top, children }: { readonly top: number; readonly children: ReactNode }) {
  return (
    <tr>
      <td style={{ paddingTop: `${top}px` }}>{children}</td>
    </tr>
  );
}

export function Html({ children }: { readonly children: ReactNode }) {
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
  return (
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="x-apple-disable-message-reformatting" />
      <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no" />
      <meta name="color-scheme" content="light dark" />
      <meta name="supported-color-schemes" content="light dark" />
      <title>{title}</title>
      {createElement(outlook)}
      <style>{MAIL_CSS}</style>
    </head>
  );
}

export function Body({ children }: { readonly children: ReactNode }) {
  return (
    <body className="dr-bg" style={{ margin: 0, padding: 0, backgroundColor: L.ground }}>
      {children}
    </body>
  );
}

// Filler stops clients pulling body text into the inbox line after the preheader.
const PREHEADER_FILL = ' ﻿͏'.repeat(40);

export function Preheader({ text }: { readonly text: string }) {
  return (
    <div
      style={
        {
          display: 'none',
          maxHeight: 0,
          maxWidth: 0,
          overflow: 'hidden',
          opacity: 0,
          msoHide: 'all',
        } as CSSProperties
      }
    >
      {text}
      {PREHEADER_FILL}
    </div>
  );
}

// The article role is the Email Markup Consortium pattern: a mail body always sits inside the
// client's own main, so it must not bring another.
export function Article({
  label: name,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="article" aria-roledescription="email" aria-label={name} lang="en" dir="ltr">
      {children}
    </div>
  );
}

export function Page({
  open,
  close,
  children,
}: {
  readonly open: string;
  readonly close: string;
  readonly children: ReactNode;
}) {
  // bgColor is a real attribute that the React types leave out.
  const paper = { bgColor: L.ground };
  return (
    <table
      {...table}
      {...paper}
      className="dr-bg"
      width="100%"
      style={{ width: '100%', backgroundColor: L.ground }}
    >
      <tbody>
        <tr>
          <td align="center" className="dr-wrap" style={{ padding: '40px 24px 48px' }}>
            {createElement(open)}
            <table
              {...table}
              width="100%"
              style={{ width: '100%', maxWidth: '560px', textAlign: 'left' }}
            >
              <tbody>{children}</tbody>
            </table>
            {createElement(close)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// The running head of a technical publication: the name as a label, not the wordmark, and
// what this mail is. It needs no image, so it survives every client.
export function Folio({ text }: { readonly text: string }) {
  return (
    <tr>
      <td
        className="dr-rule"
        style={{ paddingBottom: '16px', borderBottom: `1px solid ${L.rule}` }}
      >
        <table {...table} width="100%">
          <tbody>
            <tr>
              <td className="dr-ink dr-mono dr-folio" style={{ ...label, color: L.ink }}>
                Drefyn
              </td>
              <td
                className="dr-sec dr-mono dr-folio-label"
                align="right"
                style={{ ...label, textAlign: 'right' }}
              >
                {text}
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}

export function Heading({ text }: { readonly text: string }) {
  return (
    <Row top={40}>
      <h1
        className="dr-ink dr-h1"
        style={{ ...type(28, '1.2', L.ink), fontWeight: 600, letterSpacing: '-0.015em' }}
      >
        {text}
      </h1>
    </Row>
  );
}

export function Paragraph({ text }: { readonly text: string }) {
  return (
    <Row top={16}>
      <p className="dr-body" style={type(16, '1.6', L.body)}>
        {text}
      </p>
    </Row>
  );
}

// The gap after the fourth digit is letter spacing, not a space, so a double click, a copy
// and iOS code autofill all take eight digits.
export function Code({ code, note: expiry }: { readonly code: string; readonly note: string }) {
  return (
    <>
      <Row top={32}>
        <table {...table}>
          <tbody>
            <tr>
              <td
                className="dr-gutter"
                style={{ borderLeft: `2px solid ${L.ink}`, padding: '4px 0 4px 16px' }}
              >
                <p className="dr-sec dr-mono" style={label}>
                  Your code
                </p>
                <p
                  className="dr-ink dr-code dr-mono"
                  style={{
                    ...type(36, '1.25', L.ink),
                    fontFamily: MONO,
                    fontWeight: 500,
                    letterSpacing: '0.04em',
                    fontVariantNumeric: 'tabular-nums',
                    paddingTop: '8px',
                    WebkitUserSelect: 'all',
                    userSelect: 'all',
                  }}
                >
                  {code.slice(0, 3)}
                  <span style={{ letterSpacing: '0.5em' }}>{code.slice(3, 4)}</span>
                  {code.slice(4)}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </Row>
      <Row top={12}>
        <p className="dr-sec" style={note}>
          {expiry}
        </p>
      </Row>
    </>
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
  return (
    <Row top={quiet ? 12 : 24}>
      <p
        className="dr-body"
        style={quiet ? { ...small, lineHeight: '24px' } : type(16, '1.6', L.body)}
      >
        <a
          href={href.href}
          className="dr-link"
          style={{
            color: L.accent,
            fontWeight: 500,
            textDecoration: 'underline',
            textUnderlineOffset: '3px',
          }}
        >
          {text}
        </a>
      </p>
      {detail === undefined ? null : (
        <p className="dr-sec" style={{ ...note, paddingTop: '4px' }}>
          {detail}
        </p>
      )}
      {/* The full address, so a careful reader can check the host before opening it. */}
      <p
        className="dr-sec dr-mono"
        style={{
          ...small,
          fontFamily: MONO,
          paddingTop: quiet ? '4px' : '8px',
          wordBreak: 'break-all',
        }}
      >
        {href.href}
      </p>
    </Row>
  );
}

export function Facts({ rows }: { readonly rows: readonly FactRow[] }) {
  const edge = `1px solid ${L.rule}`;
  return (
    <Row top={24}>
      <table
        cellPadding={0}
        cellSpacing={0}
        border={0}
        width="100%"
        style={{ borderCollapse: 'collapse', width: '100%' }}
      >
        <tbody>
          {rows.map((row, index) => {
            const lines: CSSProperties = {
              borderTop: edge,
              ...(index === rows.length - 1 ? { borderBottom: edge } : {}),
              verticalAlign: 'top',
            };
            return (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="dr-sec dr-rule dr-mono"
                  style={{
                    ...label,
                    ...lines,
                    padding: '10px 16px 10px 0',
                    width: '112px',
                    textAlign: 'left',
                    lineHeight: '24px',
                  }}
                >
                  {row.label}
                </th>
                <td
                  className="dr-body dr-rule"
                  style={{
                    ...type(15, '24px', L.body),
                    ...lines,
                    padding: '10px 0',
                    fontVariantNumeric: 'tabular-nums',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {row.value}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Row>
  );
}

export function Rule() {
  return (
    <Row top={40}>
      <table {...table} width="100%">
        <tbody>
          <tr>
            <td
              className="dr-rule dr-divider"
              style={{
                borderTop: `1px solid ${L.rule}`,
                fontSize: 0,
                lineHeight: 0,
                height: '1px',
              }}
            >
              &nbsp;
            </td>
          </tr>
        </tbody>
      </table>
    </Row>
  );
}

export function Fineprint({ text, top = 24 }: { readonly text: string; readonly top?: number }) {
  return (
    <Row top={top}>
      <p className="dr-sec" style={small}>
        {text}
      </p>
    </Row>
  );
}
