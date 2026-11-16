'use client';
import { IconCross, IconPage, IconPulse, IconSchema, useLandmark } from '@drefyn/ui/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react';
import { useIncident } from '../incident/provider.tsx';
import { projectKey, seatMeta, type ShellData } from './data.ts';
import { useShell } from './frame.tsx';
import { PRODUCTS, type ProductId } from './products.ts';
import { ProductsNav } from './products-nav.tsx';
import { parseShellPath, sectionHref, shellHref } from './route.ts';
import type { RailTipProps } from './rail-tip.tsx';
import { ICON_BY_NAME } from './section-icons.ts';
import { ACCOUNT_SECTIONS, ORG_SECTIONS, SECTIONS, type SectionIcon } from './sections.ts';
import { OrganizationMenu } from './top-bar.tsx';

type ShellIcon = (props: { size?: 'sm' | 'md' }) => ReactNode;

const ICONS: Record<SectionIcon, ShellIcon> = ICON_BY_NAME;

const PRODUCT_ICON: Record<ProductId, ShellIcon> = {
  docs: IconPage,
  studio: IconSchema,
  status: IconPulse,
};

// Wherever settings are open, so a person never hunts for the other half of them.
const SETTINGS_PATH = /^\/(?:account(?:\/|$)|settings-states\/|[^/]+\/settings(?:\/|$))/;

// Labels leave the screen on the rail but stay in the accessibility tree. Incident mode puts
// wider screens on the rail too.
const RAIL_HIDDEN = 'sm:max-md:sr-only incident:md:sr-only';

// Below 40rem the sidebar is a drawer, out of the page until it opens.
const PHONE = '(width < 40rem)';
const onPhoneChange = (onChange: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
};
const onPhone = () => window.matchMedia(PHONE).matches;

// The rail's tooltips load only once a rail is on screen, at tablet widths or in incident
// mode, so wide and phone screens never pay for them. Until then, and if the load fails, the
// labels are still the links' names.
const TABLET = '(40rem <= width < 64rem)';
const onTabletChange = (onChange: () => void) => {
  const query = window.matchMedia(TABLET);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
};
const onTablet = () => window.matchMedia(TABLET).matches;

type Tip = ComponentType<RailTipProps>;
const TipContext = createContext<Tip | null>(null);

// Each rail link in order, the same before and after the tooltips wrap them.
const railLinks = (nav: HTMLElement | null) => [
  ...(nav?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []),
];

function useRailTip(rail: boolean, nav: RefObject<HTMLElement | null>): Tip | null {
  const [tip, setTip] = useState<Tip | null>(null);
  // The loaded tooltips wrap every link anew, so a link that holds focus when they render
  // is replaced and focus falls to the page. Focus can reach a link at any point before
  // that render, even after the code has arrived, so the rail keeps note of its focused
  // link the whole time rather than looking once.
  const held = useRef<{ link: HTMLAnchorElement; index: number } | null>(null);
  useEffect(() => {
    const el = nav.current;
    if (!rail || tip !== null || el === null) return;
    const note = (target: EventTarget | null) => {
      held.current =
        target instanceof HTMLAnchorElement && el.contains(target)
          ? { link: target, index: railLinks(el).indexOf(target) }
          : null;
    };
    const onFocusIn = (event: FocusEvent) => {
      note(event.target);
    };
    // Focus a person moved off the link is gone for good. Some engines say so for a link
    // being replaced too, while it is still in the page, so the note is dropped only once
    // that render is done and the link turns out to have stayed.
    const onFocusOut = (event: FocusEvent) => {
      const seen = held.current;
      if (seen?.link !== event.target) return;
      queueMicrotask(() => {
        if (held.current === seen && seen.link.isConnected) held.current = null;
      });
    };
    note(document.activeElement);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    let live = true;
    import('./rail-tip.tsx')
      .then((mod) => {
        if (live) setTip(() => mod.RailTip);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [rail, tip, nav]);
  useLayoutEffect(() => {
    const seen = held.current;
    if (tip === null || seen === null) return;
    held.current = null;
    // Only a link this render took out of the page while it held focus goes back.
    if (seen.link.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    railLinks(nav.current)[seen.index]?.focus();
  }, [tip, nav]);
  return tip;
}

function RailTip(props: RailTipProps): ReactNode {
  const Loaded = useContext(TipContext);
  return Loaded === null ? props.children : <Loaded {...props} />;
}

interface Item {
  readonly href: string;
  readonly label: string;
  readonly icon: SectionIcon;
  readonly meta?: string;
}

function NavLink({ item, current }: { item: Item; current: boolean }): ReactNode {
  const Icon = ICONS[item.icon];
  const label = useRef<HTMLSpanElement>(null);
  return (
    <RailTip label={label} text={item.label}>
      <Link
        href={item.href}
        aria-current={current ? 'page' : undefined}
        className={[
          'flex min-h-row-compact items-center gap-8 rounded-e-sm border-s-indicator px-8 transition-colors duration-fast ease-enter focus-visible:focus-ring-inset sm:max-md:justify-center sm:max-md:px-0',
          current
            ? 'border-accent-ink font-medium text-ink'
            : 'border-transparent text-body hover:bg-hover hover:text-ink',
        ].join(' ')}
      >
        <span className={current ? 'inline-flex shrink-0' : 'inline-flex shrink-0 text-secondary'}>
          <Icon />
        </span>
        <span ref={label} className={`min-w-0 flex-1 truncate ${RAIL_HIDDEN}`}>
          {item.label}
        </span>
        {item.meta === undefined ? null : (
          <>
            {' '}
            <span data-numeric="" className={`font-regular text-secondary ${RAIL_HIDDEN}`}>
              {item.meta}
            </span>
          </>
        )}
      </Link>
    </RailTip>
  );
}

export function Sidebar({ data }: { data: ShellData }): ReactNode {
  const pathname = usePathname();
  const here = parseShellPath(pathname);
  const { org, drawerOpen, setDrawerOpen } = useShell();
  const closeRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const projectLabel = useRef<HTMLSpanElement>(null);
  const project =
    here?.product === undefined || here.project === undefined
      ? undefined
      : data.projects[projectKey(here.product, here.project)];
  const product = project === undefined ? undefined : here?.product;

  const items: Item[] =
    project === undefined || product === undefined || here?.project === undefined
      ? ORG_SECTIONS.map((s) => ({
          href: s.slug === '' ? `/${org}` : `/${org}/${s.slug}`,
          label: s.label,
          icon: s.icon,
          ...(s.slug === 'settings/members' && data.seats !== null
            ? { meta: seatMeta(data.seats) }
            : {}),
        }))
      : SECTIONS[product].map((s) => ({
          href: shellHref({
            org,
            product,
            project: here.project ?? '',
            ...(s.slug === '' ? {} : { section: s.slug }),
          }),
          label: s.label,
          icon: s.icon,
        }));
  // Links carry the organization, and the state gallery's URL does not.
  const currentHref = here === null ? pathname : sectionHref({ ...here, org });
  const productLabel = PRODUCTS.find((p) => p.id === product)?.label;
  const label = project?.name ?? data.organization.name;
  // A closed drawer is display none, which cannot take focus, so F6 passes it by.
  const phone = useSyncExternalStore(onPhoneChange, onPhone, () => false);
  const tablet = useSyncExternalStore(onTabletChange, onTablet, () => false);
  const cockpit = useIncident().view === 'cockpit';
  const tip = useRailTip(tablet || cockpit, navRef);
  const landmark = useLandmark(navRef, {
    role: 'navigation',
    label,
    skip: phone && !drawerOpen,
  });

  // The drawer is modal on phones: everything else is inert, focus starts on its close
  // button, Escape and the scrim close it, and focus goes back to the menu button.
  useEffect(() => {
    if (!drawerOpen) return;
    const others = document.querySelectorAll<HTMLElement>(
      '[data-region="bar"], [data-incident-line], #main, [data-skip]',
    );
    for (const el of others) el.inert = true;
    closeRef.current?.focus();
    const phone = window.matchMedia('(width < 40rem)');
    const close = () => {
      setDrawerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    phone.addEventListener('change', close);
    return () => {
      for (const el of others) el.inert = false;
      document.removeEventListener('keydown', onKey);
      phone.removeEventListener('change', close);
      document.querySelector<HTMLElement>('[data-drawer-trigger]')?.focus();
    };
  }, [drawerOpen, setDrawerOpen]);

  // Following a link from the drawer closes it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname, setDrawerOpen]);

  return (
    <TipContext value={tip}>
      {drawerOpen ? (
        <div
          aria-hidden="true"
          onClick={() => {
            setDrawerOpen(false);
          }}
          className="fixed inset-0 z-overlay animate-fade-in bg-overlay-scrim sm:hidden"
        />
      ) : null}
      {/* The column carries the hairline, so it runs the full height of a long page while the
          nav inside stays under the bar. On phones the column steps aside for the drawer. */}
      <div className="contents sm:block sm:shrink-0 sm:border-e sm:border-rule">
        <nav
          ref={navRef}
          id="shell-nav"
          data-region="nav"
          {...landmark}
          className={[
            'flex-col gap-16 overflow-y-auto bg-ground px-8 py-12 outline-none focus-visible:focus-ring-inset',
            'sm:sticky sm:top-shell-bar sm:flex sm:h-shell-view sm:w-shell-nav-collapsed sm:shrink-0 sm:self-start sm:max-md:px-4 md:w-shell-nav incident:md:w-shell-nav-collapsed incident:md:px-4',
            drawerOpen
              ? 'max-sm:fixed max-sm:inset-y-0 max-sm:start-0 max-sm:z-overlay max-sm:flex max-sm:w-shell-drawer max-sm:border-e max-sm:border-rule-strong max-sm:bg-overlay max-sm:shadow-2'
              : 'hidden',
          ].join(' ')}
        >
          <div className="flex flex-col gap-12 sm:hidden">
            <div className="flex items-center justify-between">
              <OrganizationMenu data={data} />
              <button
                ref={closeRef}
                type="button"
                aria-label="Close navigation"
                onClick={() => {
                  setDrawerOpen(false);
                }}
                className="inline-grid size-control-md cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter hover:bg-hover hover:text-ink focus-visible:focus-ring"
              >
                <IconCross />
              </button>
            </div>
            <ProductsNav org={org} label="Products, in menu" opens={data.opens} variant="drawer" />
          </div>

          {/* A plain link to the product's project list until the switcher popover exists. */}
          {project === undefined || product === undefined ? null : (
            <RailTip label={projectLabel} text={project.name}>
              <Link
                href={`/${org}/${product}`}
                className="flex items-center gap-8 rounded-sm px-8 py-4 transition-colors duration-fast ease-enter hover:bg-hover focus-visible:focus-ring sm:max-md:justify-center sm:max-md:px-0"
              >
                <span className="inline-flex text-secondary">{PRODUCT_ICON[product]({})}</span>
                <span ref={projectLabel} className={`flex min-w-0 flex-1 flex-col ${RAIL_HIDDEN}`}>
                  <span className="truncate font-medium text-ink">{project.name}</span>
                  <span className="text-caption text-secondary">
                    {productLabel} project
                    <span className="sr-only">, all {productLabel} projects</span>
                  </span>
                </span>
              </Link>
            </RailTip>
          )}

          {SETTINGS_PATH.test(pathname) ? (
            <div className="flex flex-col gap-4">
              <h2 className={`px-8 text-label text-secondary uppercase ${RAIL_HIDDEN}`}>
                Your account
              </h2>
              <ul className="flex flex-col gap-2">
                {ACCOUNT_SECTIONS.map((section) => {
                  const href = `/${section.slug}`;
                  return (
                    <li key={href}>
                      <NavLink
                        item={{ href, label: section.label, icon: section.icon }}
                        current={href === pathname}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-4">
            <h2 className={`px-8 text-label text-secondary uppercase ${RAIL_HIDDEN}`}>
              {productLabel ?? 'Organization'}
            </h2>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} current={item.href === currentHref} />
                </li>
              ))}
            </ul>
          </div>

          {project === undefined ? null : (
            <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-12">
              <NavLink
                item={{
                  href: `/${org}/settings/plan`,
                  label: 'Plan and usage',
                  icon: 'card',
                  meta: data.organization.plan,
                }}
                current={pathname === `/${org}/settings/plan`}
              />
              <NavLink
                item={{
                  href: `/${org}/settings`,
                  label: 'Organization settings',
                  icon: 'settings',
                }}
                current={pathname === `/${org}/settings`}
              />
            </div>
          )}
        </nav>
      </div>
    </TipContext>
  );
}
