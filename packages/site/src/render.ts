import { gzipSync } from 'node:zlib';
import { cacheKey, type CacheKey } from '@drefyn/tenancy';
import { surfaceTokensCss, themeScript } from '@drefyn/ui';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { z } from 'zod';
import { HARD_FIRST_RESPONSE_BYTES } from './config.ts';
import { pruneCss } from './prune-css.ts';
import { themeCss, themeSchema } from './theme.ts';
import type {
  AssetRef,
  DocsPageData,
  FontAsset,
  PageContent,
  PageInput,
  RenderDeps,
  RenderedPage,
  Result,
  SiteError,
  SitePageData,
  StatusPageData,
  Surface,
} from './types.ts';

const BUDGETS: Readonly<Record<Surface, { jsGzipBytes: number; fontFiles: number }>> = {
  docs: { jsGzipBytes: 90_000, fontFiles: 3 },
  status: { jsGzipBytes: 50_000, fontFiles: 0 },
};

const GZIP = { level: 9 } as const;
const gzipBytes = (text: string) => gzipSync(text, GZIP).length;

const THEME_SCRIPT_GZIP_BYTES = gzipBytes(themeScript);

// renderToStaticMarkup answers a suspended boundary with its fallback and no sign of it, and a
// static page has no client to finish the job. renderToString marks the same boundary, and
// React escapes text, so page content cannot forge the mark.
const SUSPENDED = '<!--$!';

const STYLE_BREAKOUT = /<\/style/i;
const CSS_IMPORT = /@import\b/i;
// Catches a host inside image-set() and other strings as well as url().
const OFFSITE = /(?:https?:)?\/\/[^\s"')]/i;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))/gi;
const SAME_SITE = /^\/(?![/\\])/;
const FONT_FILE = /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i;

const siteUrlPath = z.string().regex(/^\/(?![/\\])[^\s"'<>]*$/);

const inputSchema = z.object({
  route: z.string(),
  locale: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  theme: themeSchema,
  policy: z.object({
    version: z.int().min(0),
    maxFirstResponseBytes: z.int().min(1).max(HARD_FIRST_RESPONSE_BYTES),
  }),
  data: z.object({
    version: z.string().min(1),
    builtAt: z.iso.datetime(),
    css: z.string(),
    scripts: z.array(
      z.object({
        kind: z.literal('script'),
        href: siteUrlPath,
        gzipBytes: z.int().min(0),
      }),
    ),
    pages: z.instanceof(Map),
  }),
});

const pageSchema = z.object({
  title: z.string(),
  description: z.string(),
  body: z.custom<ReactElement>((value) => isValidElement(value)),
});

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

// Keyed on what decides the bytes, so a new version or policy never reads an old page.
export function renderKey(surface: Surface, input: PageInput<SitePageData>): CacheKey {
  return cacheKey(
    input.tenant,
    'render',
    surface,
    input.route,
    input.locale,
    String(input.policy.version),
    input.data.version,
  );
}

function cssUrls(css: string): string[] {
  return [...css.matchAll(CSS_URL)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

function isSafeCss(css: string): boolean {
  if (STYLE_BREAKOUT.test(css) || CSS_IMPORT.test(css) || OFFSITE.test(css)) return false;
  return cssUrls(css).every((url) => SAME_SITE.test(url) || url.startsWith('data:'));
}

function fontAssets(css: string): FontAsset[] {
  const files = new Set(cssUrls(css).filter((url) => FONT_FILE.test(url)));
  return [...files].map((href) => ({ kind: 'font', href }));
}

function pageHtml(
  input: PageInput<SitePageData>,
  page: PageContent,
  body: string,
  css: string,
): string {
  const scripts = input.data.scripts.map(
    (script) => `<script defer src="${escapeHtml(script.href)}"></script>`,
  );
  return [
    `<!doctype html><html lang="${escapeHtml(input.locale)}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}">`,
    `<meta name="dr-built-at" content="${escapeHtml(input.data.builtAt)}">`,
    `<style>${css}</style><script>${themeScript}</script></head>`,
    `<body>${body}${scripts.join('')}</body></html>`,
  ].join('');
}

interface Failed {
  readonly ok: false;
  readonly error: SiteError;
}

function renderPage(
  surface: Surface,
  input: PageInput<SitePageData>,
  { log }: RenderDeps = {},
): Result<RenderedPage, SiteError> {
  const refuse = (error: SiteError): Failed => ({ ok: false, error });

  let key: CacheKey;
  try {
    key = renderKey(surface, input);
  } catch {
    // A forged tenant has no ids worth logging, and a log line must carry both.
    return refuse({ code: 'site.render_failed', reason: 'invalid_input' });
  }
  const context = {
    organizationId: input.tenant.organizationId,
    projectId: input.tenant.projectId,
    surface,
    key,
  };
  const fail = (error: SiteError): Failed => {
    const { code, ...detail } = error;
    log?.warn(code, { ...context, ...detail });
    return refuse(error);
  };

  if (!inputSchema.safeParse(input).success) {
    return fail({ code: 'site.render_failed', reason: 'invalid_input' });
  }
  const content = input.data.pages.get(input.route);
  if (content === undefined) return fail({ code: 'site.unknown_route' });
  if (!pageSchema.safeParse(content).success) {
    return fail({ code: 'site.render_failed', reason: 'invalid_input' });
  }

  let body: string;
  let suspended: boolean;
  try {
    body = renderToStaticMarkup(content.body);
    suspended = renderToString(content.body).includes(SUSPENDED);
  } catch {
    // The cause stays here: a thrown message can quote the page.
    return fail({ code: 'site.render_failed', reason: 'component_threw' });
  }
  if (suspended) {
    return fail({ code: 'site.render_failed', reason: 'client_boundary' });
  }

  const sheet = surfaceTokensCss[surface] + input.data.css + themeCss(input.theme);
  const css = pruneCss(body, sheet);
  if (!isSafeCss(css)) return fail({ code: 'site.render_failed', reason: 'unsafe_css' });

  const budget = BUDGETS[surface];
  const fonts = fontAssets(css);
  if (fonts.length > budget.fontFiles) {
    return fail({
      code: 'site.budget_exceeded',
      budget: 'fonts',
      limit: budget.fontFiles,
      actual: fonts.length,
    });
  }

  const jsGzipBytes = input.data.scripts.reduce(
    (sum, script) => sum + script.gzipBytes,
    THEME_SCRIPT_GZIP_BYTES,
  );
  if (jsGzipBytes >= budget.jsGzipBytes) {
    return fail({
      code: 'site.budget_exceeded',
      budget: 'js',
      limit: budget.jsGzipBytes,
      actual: jsGzipBytes,
    });
  }

  const html = pageHtml(input, content, body, css);
  const htmlGzipBytes = gzipBytes(html);
  const gated = surface === 'status';
  if (gated && htmlGzipBytes >= HARD_FIRST_RESPONSE_BYTES) {
    return fail({
      code: 'site.budget_exceeded',
      budget: 'first_response',
      limit: HARD_FIRST_RESPONSE_BYTES,
      actual: htmlGzipBytes,
    });
  }
  const overFirstResponseTarget = gated && htmlGzipBytes >= input.policy.maxFirstResponseBytes;
  if (overFirstResponseTarget) {
    log?.warn('site.first_response_over_target', { ...context, htmlGzipBytes });
  }

  const assets: AssetRef[] = [...fonts, ...input.data.scripts];
  return {
    ok: true,
    value: { html, assets, report: { htmlGzipBytes, jsGzipBytes, overFirstResponseTarget } },
  };
}

// Pure: the same input gives the same bytes. Nothing here reads a clock, a random source or
// the environment, and the logger only hears about a page after its bytes are settled.
export function renderDocsPage(
  input: PageInput<DocsPageData>,
  deps?: RenderDeps,
): Result<RenderedPage, SiteError> {
  return renderPage('docs', input, deps);
}

export function renderStatusPage(
  input: PageInput<StatusPageData>,
  deps?: RenderDeps,
): Result<RenderedPage, SiteError> {
  return renderPage('status', input, deps);
}
