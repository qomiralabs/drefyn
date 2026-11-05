# MDX corpus

Real Markdown and MDX pages, copied unchanged, for the byte stability tests and the bench.
Each file ends in `.mdx.txt` or `.md.txt`, because the fixtures are data and `.mdx` is not a
file type the repo allows outside the gated paths. `.txt` also keeps Prettier off them.

`manifest.json` names each file's source repo, commit, path, licence, dialect and SHA-256. The
tests fail if a file drifts from it. `licenses/` holds each source repo's licence file as it
stood at that commit: MIT for all but Supabase, which is Apache-2.0.

Docusaurus is left out because its docs are under a separate CC-BY licence. Files with en or
em dashes are left out because the repo bans them in every tracked file, and so are files
that use the words key, secret or token near an assignment, so the secret scan stays quiet.

Line ending and BOM cases are derived from these files in `test/helpers.ts`, so git and
editors never get a chance to change them.

Parser pins move only with a run of this corpus, since a new parser can change block hashes.
