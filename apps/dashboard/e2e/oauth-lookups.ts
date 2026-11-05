// Any name a browser looks up fails. The redirect to a provider dies here, so a real one is out
// of reach, and the helpers carry on to the fake from the error page.
export const NO_LOOKUPS = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
