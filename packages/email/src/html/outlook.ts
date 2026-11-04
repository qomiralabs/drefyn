// React cannot write the conditional comments classic Outlook reads, so the document holds
// these empty tags and the renderer swaps them for fixed strings. Names reach the markup
// escaped, so no text a person typed can spell one of them.
export const OUTLOOK_HEAD_TAG = 'mso-head';
export const OUTLOOK_OPEN_TAG = 'mso-open';
export const OUTLOOK_CLOSE_TAG = 'mso-close';

const HEAD =
  '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->' +
  "<!--[if mso]><style>table,td,th,p,h1,a,span{font-family:'Segoe UI',Arial,sans-serif!important}.dr-mono,.dr-mono span{font-family:Consolas,'Courier New',monospace!important}</style><![endif]-->";
// Word ignores max-width, so it gets a fixed column.
const OPEN =
  '<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->';
const CLOSE = '<!--[if mso]></td></tr></table><![endif]-->';

const tag = (name: string) => `<${name}></${name}>`;

export function fillOutlook(markup: string): string {
  return markup
    .replace(tag(OUTLOOK_HEAD_TAG), () => HEAD)
    .replace(tag(OUTLOOK_OPEN_TAG), () => OPEN)
    .replace(tag(OUTLOOK_CLOSE_TAG), () => CLOSE);
}
