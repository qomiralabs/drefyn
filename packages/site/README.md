# `@drefyn/site`

Turns one docs or status page into static HTML with our own React server render. No client
React, no hydration and no site build: a state change or a page edit renders that one page,
in under a millisecond.

The package is pure Apache 2.0 open core. It needs React, zod and two workspace packages, and
no hosted service. Next stays in the dashboard.

## Public API

```ts
const config = loadSiteConfig(process.env);
if (!config.ok) throw new Error(config.error.key);

const result = renderStatusPage(
  {
    tenant,
    route: '/',
    locale: 'en',
    theme: {},
    policy: { version: 1, maxFirstResponseBytes: config.value.maxFirstResponseBytes },
    data: { version, builtAt, css, scripts, pages },
  },
  { log },
);
if (result.ok) upload(renderKey('status', input), result.value.html);
```

- `renderDocsPage(input, deps?)` and `renderStatusPage(input, deps?)` return
  `{ ok: true, value: { html, assets, report } }` or `{ ok: false, error }`. They never throw.
  The same input gives the same bytes. They read no clock, no random source and no environment,
  so the build time arrives in `data.builtAt`.
- `pruneCss(html, css)` returns the CSS one page needs: rules whose classes appear in the page
  and custom properties something reads. It never throws. A class that only a plain script adds
  must also appear in the rendered HTML, or its rule is dropped.
- `renderKey(surface, input)` is the `CacheKey` for a page, with both tenant ids.
- `loadSiteConfig(env)` reads the one setting below.
- `data.pages` maps each route to `{ title, description, body }`. `body` is a React element, and
  for customer content it is the element `renderSafe` returned. Page templates live with each
  surface, not here.
- `theme` is `{ light, dark }` and takes only the tokens a customer may set. State colours are
  not among them.

Interactive React components stay out of public pages. A component that suspends fails the page.

## Errors

| Code                   | When                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `site.unknown_route`   | `data.pages` has no such route                                                       |
| `site.budget_exceeded` | Over the JS, font or first response budget; `budget`, `limit` and `actual` say which |
| `site.render_failed`   | `reason` is `invalid_input`, `component_threw`, `client_boundary` or `unsafe_css`    |

Unsafe CSS means a closing style tag, an `@import` or a `url()` to another host.

## Budgets

| Surface | JS gzipped   | Font files | First response gzipped               |
| ------- | ------------ | ---------- | ------------------------------------ |
| Docs    | under 90,000 | 3          | no limit                             |
| Status  | under 50,000 | 0          | warns at the target, fails at 16,000 |

The inline theme line counts as JS. `report` holds `htmlGzipBytes`, `jsGzipBytes` and
`overFirstResponseTarget` for each page.

## Configuration

| Variable                               | Default | Meaning                                                          |
| -------------------------------------- | ------- | ---------------------------------------------------------------- |
| `DREFYN_SITE_MAX_FIRST_RESPONSE_BYTES` | 14000   | Status first response warning target, a whole number up to 16000 |

## Logs

The logger in `deps` hears `site.unknown_route`, `site.render_failed`, `site.budget_exceeded` and
`site.first_response_over_target`. Lines carry the organization ID, project ID, surface, render
key and sizes. Routes, titles and page content never reach a log; the key holds a hash of the
route.

## Tests

`pnpm --filter @drefyn/site test` runs the suite. `pnpm --filter @drefyn/site bench` renders a
page of twenty components thousands of times under the production build of React and fails if
p99 reaches 5 ms.
