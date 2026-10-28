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
