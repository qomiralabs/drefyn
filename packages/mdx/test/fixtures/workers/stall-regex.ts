// The email pattern from the GFM autolink transform, on input that makes it backtrack.
const EMAIL = /(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu;
for (;;) EMAIL.test('a.'.repeat(500_000));
