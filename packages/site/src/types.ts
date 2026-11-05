import type { TenantRef } from '@drefyn/tenancy';
import type { ReactElement } from 'react';
import type { ThemeTokens } from './theme.ts';

export type Surface = 'docs' | 'status';

export interface PageContent {
  readonly title: string;
  readonly description: string;
  // Customer content arrives here as the element renderSafe made, never as HTML.
  readonly body: ReactElement;
}

export interface ScriptAsset {
  readonly kind: 'script';
  // A path on the same site, since a public page asks no other host for anything.
  readonly href: string;
  readonly gzipBytes: number;
}

export interface FontAsset {
  readonly kind: 'font';
  readonly href: string;
}

export type AssetRef = ScriptAsset | FontAsset;

export interface SitePageData {
  readonly version: string;
  // ISO 8601. Passed in because a render reads no clock.
  readonly builtAt: string;
  readonly pages: ReadonlyMap<string, PageContent>;
  // The surface stylesheet from our own build, inlined and pruned per page. The safety check
  // on it reads plain text only, so customer CSS goes through the CSS checker first.
  readonly css: string;
  readonly scripts: readonly ScriptAsset[];
}

export type DocsPageData = SitePageData;
export type StatusPageData = SitePageData;

export interface RenderPolicy {
  readonly version: number;
  // Status only: at this many gzipped bytes a page warns.
  readonly maxFirstResponseBytes: number;
}

export interface PageInput<D> {
  readonly tenant: TenantRef;
  readonly route: string;
  readonly data: D;
  readonly theme: ThemeTokens;
  readonly locale: string;
  readonly policy: RenderPolicy;
}

export interface PageReport {
  readonly htmlGzipBytes: number;
  readonly jsGzipBytes: number;
  readonly overFirstResponseTarget: boolean;
}

export interface RenderedPage {
  readonly html: string;
  readonly assets: readonly AssetRef[];
  readonly report: PageReport;
}

export type SiteErrorCode = 'site.render_failed' | 'site.budget_exceeded' | 'site.unknown_route';

export type SiteError =
  | { readonly code: 'site.unknown_route' }
  | {
      readonly code: 'site.render_failed';
      readonly reason: 'invalid_input' | 'component_threw' | 'client_boundary' | 'unsafe_css';
    }
  | {
      readonly code: 'site.budget_exceeded';
      readonly budget: 'js' | 'first_response' | 'fonts';
      readonly limit: number;
      readonly actual: number;
    };

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface SiteLogger {
  warn(event: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}

export interface RenderDeps {
  readonly log?: SiteLogger;
}
