'use client';
import { IconCross, IconPage, IconPulse, IconSchema, useLandmark } from '@drefyn/ui/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { ShellData } from './data.ts';
import { useShell } from './frame.tsx';
import { PRODUCTS, type ProductId } from './products.ts';
import { ProductsNav } from './products-nav.tsx';
import { parseShellPath, shellHref } from './route.ts';
import { ICON_BY_NAME } from './section-icons.ts';
import { ORG_SECTIONS, SECTIONS, type SectionIcon } from './sections.ts';
import { OrganizationMenu } from './top-bar.tsx';

type ShellIcon = (props: { size?: 'sm' | 'md' }) => ReactNode;

const ICONS: Record<SectionIcon, ShellIcon> = ICON_BY_NAME;

const PRODUCT_ICON: Record<ProductId, ShellIcon> = {
  docs: IconPage,
  studio: IconSchema,
  status: IconPulse,
};

// Labels leave the screen on the tablet rail but stay in the accessibility tree.
const RAIL_HIDDEN = 'sm:max-md:sr-only';

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

interface Item {
  readonly href: string;
  readonly label: string;
  readonly icon: SectionIcon;
  readonly meta?: string;
}

function NavLink({ item, current }: { item: Item; current: boolean }): ReactNode {
  const Icon = ICONS[item.icon];
  return (
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
      <span className={`min-w-0 flex-1 truncate ${RAIL_HIDDEN}`}>{item.label}</span>
      {item.meta === undefined ? null : (
        <>
          {' '}
          <span data-numeric="" className={`font-regular text-secondary ${RAIL_HIDDEN}`}>
            {item.meta}
          </span>
        </>
      )}
    </Link>
  );
}

export function Sidebar({ data }: { data: ShellData }): ReactNode {
  const pathname = usePathname();
  const here = parseShellPath(pathname);
  const { org, drawerOpen, setDrawerOpen } = useShell();
  const closeRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const project = here?.project === undefined ? undefined : data.projects[here.project];
  const product = project === undefined ? undefined : here?.product;

  const items: Item[] =
    project === undefined || product === undefined || here?.project === undefined
      ? ORG_SECTIONS.map((s) => ({
          href: s.slug === '' ? `/${org}` : `/${org}/${s.slug}`,
          label: s.label,
          icon: s.icon,
          ...(s.slug === 'settings/members'
            ? { meta: `${data.seats.used} of ${data.seats.included}` }
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
  const productLabel = PRODUCTS.find((p) => p.id === product)?.label;
  const label = project?.name ?? data.organization.name;
  // A closed drawer is display none, which cannot take focus, so F6 passes it by.
  const phone = useSyncExternalStore(onPhoneChange, onPhone, () => false);
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
      '[data-region="bar"], #main, [data-skip]',
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
    <>
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
            'sm:sticky sm:top-shell-bar sm:flex sm:h-shell-view sm:w-shell-nav-collapsed sm:shrink-0 sm:self-start sm:max-md:px-4 md:w-shell-nav',
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
            <Link
              href={`/${org}/${product}`}
              className="flex items-center gap-8 rounded-sm px-8 py-4 transition-colors duration-fast ease-enter hover:bg-hover focus-visible:focus-ring sm:max-md:justify-center sm:max-md:px-0"
            >
              <span className="inline-flex text-secondary">{PRODUCT_ICON[product]({})}</span>
              <span className={`flex min-w-0 flex-1 flex-col ${RAIL_HIDDEN}`}>
                <span className="truncate font-medium text-ink">{project.name}</span>
                <span className="text-caption text-secondary">
                  {productLabel} project
                  <span className="sr-only">, all {productLabel} projects</span>
                </span>
              </span>
            </Link>
          )}

          <div className="flex flex-col gap-4">
            <h2 className={`px-8 text-label text-secondary uppercase ${RAIL_HIDDEN}`}>
              {productLabel ?? 'Organization'}
            </h2>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} current={item.href === pathname} />
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
    </>
  );
}
