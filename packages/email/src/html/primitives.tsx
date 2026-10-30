// Mail clients drop most CSS, so everything here is tables and inline styles. These are
// deliberately plain until the designed templates land; the design spike settles the
// look, and only the values below change.
import { tokens } from '@drefyn/ui';
import type { CSSProperties, ReactNode } from 'react';

const c = tokens.color;
const sans = tokens.font.sans.join(', ');
const mono = tokens.font.mono.join(', ');

const text: CSSProperties = {
  margin: '0 0 16px',
  color: c.text.body.light,
  fontFamily: sans,
  fontSize: '16px',
  lineHeight: '1.6',
};

export function Html({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      {children}
    </html>
  );
}

export function Head({ title }: { readonly title: string }) {
  return (
    <head>
      <meta httpEquiv="Content-Type" content="text/html; charset=UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light only" />
      <title>{title}</title>
    </head>
  );
}

export function Body({ children }: { readonly children: ReactNode }) {
  return (
    <body style={{ margin: 0, padding: 0, backgroundColor: c.surface.ground.light }}>
      {children}
    </body>
  );
}

// Shown by inbox lists next to the subject, hidden in the opened message.
export function Preheader({ text: value }: { readonly text: string }) {
  return (
    <div
      style={{
        display: 'none',
        overflow: 'hidden',
        maxHeight: 0,
        maxWidth: 0,
        opacity: 0,
        lineHeight: '1px',
      }}
    >
      {value}
    </div>
  );
}

export function Container({ children }: { readonly children: ReactNode }) {
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ backgroundColor: c.surface.ground.light }}
    >
      <tbody>
        <tr>
          <td align="center" style={{ padding: '32px 16px' }}>
            <table
              role="presentation"
              width="100%"
              cellPadding={0}
              cellSpacing={0}
              border={0}
              style={{ maxWidth: '560px' }}
            >
              <tbody>
                <tr>
                  <td align="left">{children}</td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function Heading({ children }: { readonly children: ReactNode }) {
  return (
    <h1
      style={{
        ...text,
        color: c.text.ink.light,
        fontSize: '22px',
        lineHeight: '1.3',
        fontWeight: 600,
      }}
    >
      {children}
    </h1>
  );
}

export function Text({
  children,
  small = false,
}: {
  readonly children: ReactNode;
  readonly small?: boolean;
}) {
  return (
    <p style={small ? { ...text, color: c.text.secondary.light, fontSize: '13px' } : text}>
      {children}
    </p>
  );
}

export function Code({ code }: { readonly code: string }) {
  return (
    <p
      style={{
        ...text,
        color: c.text.ink.light,
        fontFamily: mono,
        fontSize: '28px',
        letterSpacing: '0.12em',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {code}
    </p>
  );
}

export function Link({ href, children }: { readonly href: URL; readonly children: ReactNode }) {
  return (
    <a href={href.href} style={{ color: c.accent.ink.light, textDecoration: 'underline' }}>
      {children}
    </a>
  );
}

export function Rule() {
  return (
    <hr
      style={{
        border: 'none',
        borderTop: `1px solid ${c.border.rule.light}`,
        margin: '24px 0',
      }}
    />
  );
}

export function Facts({
  rows,
}: {
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}) {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ margin: '0 0 16px' }}
    >
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td style={{ ...text, margin: 0, paddingRight: '16px', color: c.text.secondary.light }}>
              {row.label}
            </td>
            <td style={{ ...text, margin: 0 }}>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
