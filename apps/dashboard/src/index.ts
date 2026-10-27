// What other workspace code may read from the dashboard: the shell's URL model and the
// bundle budget math. The app itself lives under src/app.
export { PRODUCTS, type ProductId } from './shell/products.ts';
export {
  RESERVED_SLUGS,
  parseShellPath,
  productHref,
  shellHref,
  type ShellLocation,
} from './shell/route.ts';
export { DASHBOARD_FLAG, dashboardEnabled } from './shell/release.ts';
export {
  BASELINE_GROWTH_LIMIT,
  KB,
  ROUTE_BUDGET_BYTES,
  baselineReport,
  routeReport,
  type BaselineReport,
  type RouteReport,
  type ScriptSize,
} from './bundle/budget.ts';
