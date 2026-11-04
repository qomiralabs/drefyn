# Assets

Every non code asset in the repo, with its source and licence.

## Fonts

Latin subsets taken unchanged from the Fontsource npm packages, which cut them from the upstream
releases: Inter from github.com/rsms/inter and JetBrains Mono from
github.com/JetBrains/JetBrainsMono. Each source is an exact npm tarball; the file sits under
`package/files/` in it, and each licence file is that tarball's `package/LICENSE`, byte for byte.

Both families are under the SIL Open Font License 1.1, which the licence files carry in full with
each project's copyright line. A subset is a Modified Version under the OFL; it keeps the family
name because neither project declares a Reserved Font Name.

The version is the font's own name table entry (name ID 5). `packages/ui/test/fonts.test.ts`
reads this table and fails if a file is missing from it, its SHA-256 differs, or its version
string differs.

| File in `packages/ui/src/fonts`         | Source                                                                             | Version                       | Licence                 | SHA-256                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `inter-latin-400-normal.woff2`          | `https://registry.npmjs.org/@fontsource/inter/-/inter-5.3.0.tgz`                   | `Version 4.001;git-66647c0bb` | `Inter-OFL.txt`         | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` |
| `inter-latin-500-normal.woff2`          | `https://registry.npmjs.org/@fontsource/inter/-/inter-5.3.0.tgz`                   | `Version 4.001;git-66647c0bb` | `Inter-OFL.txt`         | `f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f` |
| `inter-latin-600-normal.woff2`          | `https://registry.npmjs.org/@fontsource/inter/-/inter-5.3.0.tgz`                   | `Version 4.001;git-66647c0bb` | `Inter-OFL.txt`         | `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a` |
| `Inter-OFL.txt`                         | `https://registry.npmjs.org/@fontsource/inter/-/inter-5.3.0.tgz`                   | SIL OFL 1.1                   | itself                  | `3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345` |
| `jetbrains-mono-latin-400-normal.woff2` | `https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz` | `Version 2.211`               | `JetBrainsMono-OFL.txt` | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `jetbrains-mono-latin-500-normal.woff2` | `https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz` | `Version 2.211`               | `JetBrainsMono-OFL.txt` | `cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a` |
| `JetBrainsMono-OFL.txt`                 | `https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz` | SIL OFL 1.1                   | itself                  | `403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b` |

Tarball integrity as the registry publishes it, to check a download before unpacking:

- `@fontsource/inter@5.3.0`: `sha512-RofMylZmjlJEfELXeNHFWBRcSs75rGU/6bV2S2jfnvv/3rPXPGe0LgUJTklcHZ9lM4OZmAVFhcJPnACfb91A3g==`
- `@fontsource/jetbrains-mono@5.3.0`: `sha512-fqDfB5I9f1p1TV486aUgB9t8zP84P0O1FtQR5Ol9vjwPy+S+EIGlVYm1cvj2W5shcZMTg2nZFdVMoH5wFu8a1A==`

## Icons

| File                              | Source                                                                                  | Licence                  |
| --------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| `apps/dashboard/src/app/icon.svg` | Our own drawing of the Drefyn mark on its 100 unit grid, ink in light and paper in dark | Apache-2.0 with the repo |

## Provider marks and the Google button font

Official third party assets, copied byte for byte and shown only on the sign in provider buttons.
They are not covered by this repository's Apache-2.0 licence: each stays under its owner's terms,
and the marks remain trademarks of their owners. Their use here does not imply endorsement. Both
are in `apps/dashboard/src/auth/marks/`. The owner accepted these uses on 2026-11-04.

| File                                 | Source                                                                                           | Terms                                                                                                   | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `github-black.svg`                   | `https://brand.github.com/GitHub_Logos.zip`, `GitHub_Invertocat_Black.svg`                       | GitHub trademark, used to show the GitHub integration under `https://brand.github.com/foundations/logo` | `693d7abe6f899646cc2e96856723b45e95f71885a54910b2749f6decdf7e1ee1` |
| `github-white.svg`                   | `https://brand.github.com/GitHub_Logos.zip`, `GitHub_Invertocat_White.svg`                       | As above                                                                                                | `ccd84c89b1056345608fc3489357f8acc7397e49a3cdc2d418b6c8016911d47b` |
| `google-light.svg`                   | `https://developers.google.com/static/identity/images/signin-assets.zip`, Light, square, no text | Google trademark, used under `https://developers.google.com/identity/branding-guidelines`               | `6587b180203a99da15c0a041018e15c94ffd9556c4b9855bdc69806081a93791` |
| `google-dark.svg`                    | The same bundle, Dark, square, no text                                                           | As above                                                                                                | `2f7ecc307b1db0f1738456269ee2c4433b3a73c35060ced67a9afcfc6821e786` |
| `google-sans-latin-500-normal.woff2` | `https://registry.npmjs.org/@fontsource/google-sans/-/google-sans-5.3.2.tgz`                     | SIL Open Font License 1.1, in `GoogleSans-OFL.txt`                                                      | `7ee2b232de66f7530be28964818bc8a813e62553138e48bffd917e95b19bd7fa` |
| `GoogleSans-OFL.txt`                 | The same tarball, `package/LICENSE`                                                              | SIL OFL 1.1, itself                                                                                     | `ee5ba219bfa2ce3cb1403d2a535383cd131c9154912560c286691781203fd02d` |

Google requires Google Sans Medium on its sign in button, so the font loads from the sign in
pages' own stylesheet and reaches no other surface. The Google button also uses Google's required
fill, stroke and text colours, kept in `auth.css` as named values on that button alone.

## Container images

Images the repository pulls by digest and never ships. Each digest is the multi arch index
(amd64 and arm64).

| Image                     | Used by                                                                      | Source                               | Licence |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ | ------- |
| `axllent/mailpit:v1.32.0` | `deploy/compose.yaml` test profile, `scripts/email-integration` (tests only) | `https://github.com/axllent/mailpit` | MIT     |
