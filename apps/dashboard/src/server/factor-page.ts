import { correction, generate } from 'lean-qr';
import { toSvgPath } from 'lean-qr/extras/svg';

// The pages that show an authenticator secret or recovery codes. They are written here as
// plain HTML, not rendered by React, so every byte of the body is ours to count: no script,
// no framework payload, no hidden field and no style attribute. Each value appears once.

export const FACTOR_STYLE_PATH = '/auth/factor-style';
export const SETTINGS_PATH = '/account/sign-in';
export const CONFIRM_PATH = '/account/second-factor/confirm';

// M until a person has scanned the longest address on real phones at L and at M.
const QR_CORRECTION = correction.M;
// The blank border a scanner needs, in modules.
const QUIET_ZONE = 4;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Every value has a closed alphabet already; escaping anyway costs nothing.
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export interface QrDrawing {
  readonly path: string;
  readonly size: number;
}

// The matrix as one path, drawn on the server so no QR code reaches the browser bundle.
export function drawQr(uri: string): QrDrawing {
  const code = generate(uri, {
    minCorrectionLevel: QR_CORRECTION,
    maxCorrectionLevel: QR_CORRECTION,
  });
  return { path: toSvgPath(code), size: code.size };
}

function page(title: string, main: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}, Drefyn</title>`,
    `<link rel="stylesheet" href="${FACTOR_STYLE_PATH}">`,
    '</head>',
    '<body>',
    `<main class="factor">${main}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}

const head = (claim: string, rest: string) =>
  `<p class="factor-label">Your account</p><h1><span class="factor-claim">${escapeHtml(claim)}</span> ${escapeHtml(rest)}</h1>`;

export interface EnrolView {
  readonly otpauthUri: string;
  readonly manualKey: string;
  // The last code did not match: say so and keep the same secret.
  readonly mistyped: boolean;
}

export function enrolPage(view: EnrolView): string {
  const qr = drawQr(view.otpauthUri);
  const box = qr.size + QUIET_ZONE * 2;
  const error = view.mistyped
    ? '<p class="factor-error" id="code-error">That code did not match. Use the newest code in the app; each one lasts 30 seconds.</p>'
    : '';
  const described = view.mistyped ? 'code-hint code-error' : 'code-hint';
  return page(
    'Add an authenticator app',
    [
      head('Add an authenticator app.', 'Scan the code, then type the 6 digits it shows.'),
      '<p class="factor-lede">Any app that makes 6 digit codes works, such as 1Password, Google Authenticator, Microsoft Authenticator or Aegis.</p>',
      '<div class="factor-pair">',
      `<figure class="factor-qr"><svg role="img" aria-labelledby="qr-name" viewBox="${String(-QUIET_ZONE)} ${String(-QUIET_ZONE)} ${String(box)} ${String(box)}" shape-rendering="crispEdges"><title id="qr-name">QR code for your authenticator app</title><path d="${escapeHtml(qr.path)}"/></svg></figure>`,
      '<div class="factor-key">',
      '<h2>Cannot scan it?</h2>',
      '<p>Choose to enter a key by hand in the app, and type this one. Spaces do not matter.</p>',
      `<p class="factor-secret"><code>${escapeHtml(view.manualKey)}</code></p>`,
      '</div>',
      '</div>',
      `<form class="factor-form" method="post" action="${CONFIRM_PATH}">`,
      '<label for="code">6 digit code from the app</label>',
      '<p class="factor-hint" id="code-hint">Nothing changes until this code matches.</p>',
      error,
      `<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" minlength="6" maxlength="7" spellcheck="false" required autofocus aria-describedby="${described}"${view.mistyped ? ' aria-invalid="true"' : ''}>`,
      '<button type="submit">Turn on</button>',
      '</form>',
      `<p class="factor-links"><a href="${SETTINGS_PATH}">Cancel</a></p>`,
    ].join('\n'),
  );
}

export interface CodesView {
  readonly recoveryCodes: readonly string[];
  // Turned on just now, or a fresh set for someone already enrolled.
  readonly reason: 'enrolled' | 'replaced';
}

export function codesPage(view: CodesView): string {
  const enrolled = view.reason === 'enrolled';
  const items = view.recoveryCodes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`);
  return page(
    enrolled ? 'Your authenticator app is on' : 'New recovery codes',
    [
      enrolled
        ? head('Your authenticator app is on.', 'Save your recovery codes before you go.')
        : head('New recovery codes.', 'Your old ones stopped working just now.'),
      '<p class="factor-lede">Each code signs you in once if you lose your phone. This is the only time we show them.</p>',
      `<ol class="factor-codes" aria-label="Recovery codes">${items.join('')}</ol>`,
      '<p class="factor-lede">Keep them somewhere other than your phone, such as a password manager or a printed page.</p>',
      enrolled
        ? '<p class="factor-hint">We signed out your other sessions and emailed you a notice. API keys keep working.</p>'
        : '<p class="factor-hint">We emailed you a notice.</p>',
      `<p class="factor-links"><a class="factor-done" href="${SETTINGS_PATH}">I saved them</a></p>`,
    ].join('\n'),
  );
}

// Laid out for the pages above alone; tokens only, light and dark by the system setting,
// since no script runs here to read a stored choice.
export const FACTOR_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--dr-surface-ground); color: var(--dr-text-body); -webkit-font-smoothing: antialiased; }
body { margin: 0; font: var(--dr-type-body-s); }
.factor { max-width: calc(var(--dr-landing) + 2 * var(--dr-gutter)); margin: 0 auto; padding: var(--dr-space-64) var(--dr-gutter) var(--dr-space-96); display: flex; flex-direction: column; gap: var(--dr-space-24); }
.factor-label { margin: 0; font: var(--dr-type-label); letter-spacing: var(--dr-type-label-tracking); text-transform: uppercase; color: var(--dr-text-subtle); }
h1 { margin: 0; font: var(--dr-type-display-s); letter-spacing: var(--dr-type-display-s-tracking); color: var(--dr-text-secondary); max-width: var(--dr-measure); }
.factor-claim { color: var(--dr-text-ink); }
h2 { margin: 0; font: var(--dr-type-body-m); font-weight: var(--dr-weight-strong); color: var(--dr-text-ink); }
p { margin: 0; }
.factor-lede { font: var(--dr-type-body-m); max-width: var(--dr-measure); }
.factor-hint, .factor-links { color: var(--dr-text-secondary); }
.factor-pair { display: grid; gap: var(--dr-space-24); padding-block: var(--dr-space-24); border-block: var(--dr-stroke-hairline) solid var(--dr-border-rule); }
@media (width >= 40rem) { .factor-pair { grid-template-columns: auto 1fr; align-items: start; } }
.factor-qr { margin: 0; width: 100%; max-width: calc(var(--dr-space-128) * 2.25); background: var(--dr-surface-ground); border: var(--dr-stroke-hairline) solid var(--dr-border-rule); border-radius: var(--dr-radius-sm); }
.factor-qr svg { display: block; width: 100%; height: auto; }
.factor-qr path { fill: var(--dr-text-ink); }
@media (prefers-color-scheme: dark) {
  .factor-qr { background: var(--dr-text-ink); }
  .factor-qr path { fill: var(--dr-surface-ground); }
}
.factor-key { display: flex; flex-direction: column; gap: var(--dr-space-8); }
.factor-secret code, .factor-codes code { font: var(--dr-type-code); color: var(--dr-text-ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.factor-secret { padding: var(--dr-space-12) var(--dr-space-16); background: var(--dr-surface-sunken); border-radius: var(--dr-radius-sm); }
.factor-form { display: flex; flex-direction: column; gap: var(--dr-space-8); max-width: var(--dr-layout-auth); }
label { font-weight: var(--dr-weight-medium); color: var(--dr-text-ink); }
input { font: var(--dr-type-code); letter-spacing: var(--dr-type-label-tracking); height: var(--dr-size-control-lg); padding: 0 var(--dr-space-12); color: var(--dr-text-ink); background: var(--dr-surface-ground); border: var(--dr-stroke-hairline) solid var(--dr-border-control); border-radius: var(--dr-radius-sm); }
input[aria-invalid="true"] { border-color: var(--dr-state-broken-mark); }
.factor-error { color: var(--dr-state-broken-text); }
button, .factor-done { display: inline-flex; align-items: center; justify-content: center; height: var(--dr-size-control-lg); padding: 0 var(--dr-space-16); font: inherit; font-weight: var(--dr-weight-medium); color: var(--dr-accent-on); background: var(--dr-accent-ink); border: 0; border-radius: var(--dr-radius-sm); text-decoration: none; cursor: pointer; transition: background-color var(--dr-duration-fast) var(--dr-ease-enter); }
button:hover, .factor-done:hover { background: var(--dr-accent-press); }
.factor-form button { margin-top: var(--dr-space-8); }
a { color: var(--dr-accent-ink); }
.factor-links .factor-done { color: var(--dr-accent-on); }
:focus-visible { outline: var(--dr-stroke-focus) solid var(--dr-focus-ring); outline-offset: var(--dr-stroke-focus-offset); }
.factor-codes { margin: 0; padding: var(--dr-space-16) var(--dr-space-16) var(--dr-space-16) var(--dr-space-48); display: grid; gap: var(--dr-space-8); background: var(--dr-surface-sunken); border-radius: var(--dr-radius-sm); }
.factor-codes li::marker { font: var(--dr-type-code); color: var(--dr-text-subtle); }
@media (width >= 40rem) { .factor-codes { grid-template-columns: 1fr 1fr; column-gap: var(--dr-space-48); } }
@media (prefers-reduced-motion: reduce) { button, .factor-done { transition: none; } }
`;
