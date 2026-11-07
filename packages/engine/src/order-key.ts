// Keys sort as plain bytes, so digits come before capitals and capitals before lower case. The
// column is collated to match.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// One spot used about 6,000 times in a row. Past this a key is refused rather than left to the
// index, whose own limit is a raw database error at about 2,700 bytes.
export const MAX_ORDER_KEY_CHARS = 1024;

// A key is an integer, then a fraction. The first letter gives the integer's length, 'a0' to 'az'
// then 'b00' to 'bzz', and 'Zz' downwards the same way, so adding at either end stays short for
// any list a project can hold. Only inserts in one gap make a key longer.
const SMALLEST_INTEGER = `A${'0'.repeat(26)}`;

const integerLength = (head: string): number => {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  return 0;
};

const integerOf = (key: string): string => key.slice(0, integerLength(key.charAt(0)));

// A fraction ending in the lowest digit would leave no room just below it: nothing sorts
// between 'a1' and 'a10'.
export function isOrderKey(key: string): boolean {
  if (!/^[0-9A-Za-z]+$/.test(key) || key === SMALLEST_INTEGER) return false;
  const size = integerLength(key.charAt(0));
  return size > 0 && key.length >= size && !(key.length > size && key.endsWith('0'));
}

const digitAt = (text: string, at: number) => DIGITS.indexOf(text.charAt(at));

// Null past the top of the range, 'z' and 26 more digits.
function nextInteger(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = Array.from(integer.slice(1));
  for (let at = digits.length - 1; at >= 0; at -= 1) {
    const digit = digitAt(integer, at + 1);
    if (digit < DIGITS.length - 1) {
      digits[at] = DIGITS.charAt(digit + 1);
      return head + digits.join('');
    }
    digits[at] = '0';
  }
  if (head === 'Z') return 'a0';
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (head >= 'a') digits.push('0');
  else digits.pop();
  return next + digits.join('');
}

// Never called on the smallest integer, which isOrderKey keeps out.
function previousInteger(integer: string): string {
  const head = integer.charAt(0);
  const digits = Array.from(integer.slice(1));
  for (let at = digits.length - 1; at >= 0; at -= 1) {
    const digit = digitAt(integer, at + 1);
    if (digit > 0) {
      digits[at] = DIGITS.charAt(digit - 1);
      return head + digits.join('');
    }
    digits[at] = 'z';
  }
  if (head === 'a') return 'Zz';
  const previous = String.fromCharCode(head.charCodeAt(0) - 1);
  if (head <= 'Z') digits.push('z');
  else digits.pop();
  return previous + digits.join('');
}

// Between two fractions, low below high, or above low when high is null. Halves the gap, the best
// answer when nobody can say which side the next insert will take.
function midpoint(low: string, high: string | null): string {
  let prefix = '';
  let [a, b] = [low, high];
  for (;;) {
    if (b !== null) {
      let shared = 0;
      while (shared < b.length && (a.charAt(shared) || '0') === b.charAt(shared)) shared += 1;
      prefix += b.slice(0, shared);
      a = a.slice(shared);
      b = b.slice(shared);
    }
    const lowDigit = a === '' ? 0 : digitAt(a, 0);
    const highDigit = b === null ? DIGITS.length : digitAt(b, 0);
    if (highDigit - lowDigit > 1) {
      return prefix + DIGITS.charAt(Math.floor((lowDigit + highDigit) / 2));
    }
    if (b !== null && b.length > 1) return prefix + b.charAt(0);
    prefix += DIGITS.charAt(lowDigit);
    a = a.slice(1);
    b = null;
  }
}

function below(high: string): string {
  const integer = integerOf(high);
  if (integer === SMALLEST_INTEGER) return integer + midpoint('', high.slice(integer.length));
  return integer < high ? integer : previousInteger(integer);
}

function above(low: string): string {
  const integer = integerOf(low);
  return nextInteger(integer) ?? integer + midpoint(low.slice(integer.length), null);
}

function inside(low: string, high: string): string {
  const [lowInteger, highInteger] = [integerOf(low), integerOf(high)];
  const fraction = low.slice(lowInteger.length);
  if (lowInteger === highInteger) {
    return lowInteger + midpoint(fraction, high.slice(highInteger.length));
  }
  const next = nextInteger(lowInteger);
  return next !== null && next < high ? next : lowInteger + midpoint(fraction, null);
}

// Pure, so two calls with the same neighbours give the same key. That is safe only because moves
// in a project queue on one lock. Null when no key can sit there: a tie, a reversed pair, or a
// neighbour that is not a key.
export function orderKeyBetween(low: string | null, high: string | null): string | null {
  if ((low !== null && !isOrderKey(low)) || (high !== null && !isOrderKey(high))) return null;
  if (low === null) return high === null ? 'a0' : below(high);
  if (high === null) return above(low);
  return low < high ? inside(low, high) : null;
}
