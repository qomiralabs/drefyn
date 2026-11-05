// Any name a browser looks up fails, whatever the routes do or miss. Playwright routes no
// request a redirect makes, so this is what holds if the handover to the fake ever stops
// working: the browser gets a lookup error, not a real provider.
export const NO_LOOKUPS = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
