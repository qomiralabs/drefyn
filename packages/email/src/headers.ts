// C0, DEL and C1 controls, plus the two Unicode line breaks some clients honour.
export const CONTROL = /[\p{Cc}\u2028\u2029]/u;
// RFC 5322 field names: printable ASCII other than the colon.
const FIELD_NAME = /^[!-9;-~]+$/;
const MAX_LINE = 998;
// "=?UTF-8?B?" and "?=".
const ENCODED_WORD_OVERHEAD = 12;

// The value as it would travel: ASCII as is, anything else as one base64 encoded word,
// which is the longest form a transport would choose.
function encodedLength(value: string): number {
  if (/^[\x20-\x7e]*$/.test(value)) return value.length;
  const bytes = Buffer.byteLength(value, 'utf8');
  return ENCODED_WORD_OVERHEAD + Math.ceil(bytes / 3) * 4;
}

export function isHeaderSafe(name: string, value: string): boolean {
  if (!FIELD_NAME.test(name)) return false;
  if (CONTROL.test(value)) return false;
  return name.length + 2 + encodedLength(value) <= MAX_LINE;
}
