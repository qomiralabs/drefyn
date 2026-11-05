import { serveJobs } from '../../../src/worker-host.ts';

// The email pattern from the GFM autolink transform, on input that makes it backtrack. One
// call, so the kill has to land inside the regular expression and not between two of them.
const EMAIL = /(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu;
serveJobs(() => EMAIL.test('a.'.repeat(500_000)));
