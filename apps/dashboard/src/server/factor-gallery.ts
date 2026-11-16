import { codesPage, enrolPage } from './factor-page.ts';

// Made up values in the real shapes: a secret no account holds, and codes in the
// recovery alphabet that were never issued.
const SAMPLE_KEY = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
const ENROLMENT = {
  otpauthUri: `otpauth://totp/Drefyn:maya%40acme.dev?secret=${SAMPLE_KEY}&issuer=Drefyn&algorithm=SHA1&digits=6&period=30`,
  manualKey: SAMPLE_KEY.replace(/(.{4})(?=.)/g, '$1 '),
};
const CODES = [
  'k3m9qd-7xw2ph-c8vn4t-r6yb0a',
  'p2h7wx-4kz9md-b6tq3n-v8cr1e',
  'x9d4mc-2pn7vb-h3wk8q-t5zr6f',
  'b7q2tz-9hm4xe-n6vc3p-d8kw5g',
  'r4w8nk-6ct2qz-m9xh7b-e3vp1s',
  'h6v3pe-8mx5kd-q2zn9t-c7wb4j',
  'z8c5rb-3qk6wn-t9pd2x-m4hv7a',
  'n2t9vx-5bz8hc-k7mq4e-w3rd6p',
  'e5k7dq-9wv3mp-x2cb8n-h6tz4r',
  'm3x6hb-7rp2tv-d9qk5z-c4ne8w',
];

export const FACTOR_STATES: Readonly<Record<string, () => string>> = {
  enrol: () => enrolPage({ ...ENROLMENT, mistyped: false }),
  mistyped: () => enrolPage({ ...ENROLMENT, mistyped: true }),
  enrolled: () => codesPage({ recoveryCodes: CODES, reason: 'enrolled' }),
  replaced: () => codesPage({ recoveryCodes: CODES, reason: 'replaced' }),
};
