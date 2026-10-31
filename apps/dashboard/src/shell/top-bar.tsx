'use client';
import {
  IconCheck,
  IconMenu,
  IconSearch,
  IconUpDown,
  Mark,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  toast,
  useLandmark,
} from '@drefyn/ui/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShellData } from './data.ts';
import { useShell } from './frame.tsx';
import { Inbox } from './inbox.tsx';
import { PRODUCTS } from './products.ts';
import { ProductsNav } from './products-nav.tsx';
import { parseShellPath } from './route.ts';
import { applyTheme, currentTheme, type ThemeChoice } from './theme.ts';

const QUIET_ICON =
  'inline-grid size-control-md shrink-0 cursor-pointer place-items-center rounded-sm text-secondary transition-colors duration-fast ease-enter hover:bg-hover hover:text-ink focus-visible:focus-ring';

// Things the placeholder shell lists but cannot do yet say so instead of doing nothing.
const notYet = (what: string) => () => {
  toast({ title: `${what} is not available yet.` });
};

export function OrganizationMenu({ data }: { data: ShellData }): ReactNode {
  const router = useRouter();
  const org = data.organization.slug;
  const go = (path: string) => () => {
    router.push(`/${org}${path}`);
  };
  return (
    <Menu
      variant="quiet"
      label="Organization"
      trigger={
        <>
          <span className="font-medium text-ink">{data.organization.name}</span>
          <span className="inline-flex text-secondary">
            <IconUpDown />
          </span>
        </>
      }
    >
      <MenuItem id="plan" onAction={go('/settings/plan')}>
        Plan and usage
      </MenuItem>
      <MenuItem id="members" onAction={go('/settings/members')}>
        Members
      </MenuItem>
      <MenuItem id="settings" onAction={go('/settings')}>
        Organization settings
      </MenuItem>
      <MenuSeparator />
      <MenuItem id="create" onAction={notYet('Creating an organization')}>
        Create organization
      </MenuItem>
    </Menu>
  );
}

function AccountMenu({ data }: { data: ShellData }): ReactNode {
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const choose = (choice: ThemeChoice) => () => {
    applyTheme(choice);
    setTheme(choice);
  };
  useEffect(() => {
    setTheme(currentTheme());
  }, []);
  // Menu has no selection mode yet, so the current theme shows as a check beside a plain item.
  const mark = (choice: ThemeChoice) =>
    theme === choice ? <IconCheck /> : <span className="size-icon-sm" />;
  return (
    // The trigger is the circle: as tall as the other bar controls, so two initials have
    // clear space on every side, with its edge and its hover and open fills on the circle.
    <Menu
      variant="secondary"
      triggerShape="round"
      label="Account"
      triggerLabel={`${data.person.initials}, account for ${data.person.name}`}
      trigger={
        <span className="text-caption font-medium text-secondary">{data.person.initials}</span>
      }
    >
      <MenuSection title="Theme">
        <MenuItem id="theme-system" icon={mark('system')} onAction={choose('system')}>
          System
        </MenuItem>
        <MenuItem id="theme-light" icon={mark('light')} onAction={choose('light')}>
          Light
        </MenuItem>
        <MenuItem id="theme-dark" icon={mark('dark')} onAction={choose('dark')}>
          Dark
        </MenuItem>
      </MenuSection>
      <MenuSeparator />
      <MenuItem id="shortcuts" shortcut="?" onAction={notYet('The shortcuts sheet')}>
        Keyboard shortcuts
      </MenuItem>
      <MenuItem id="profile" onAction={notYet('Profile and security')}>
        Profile and security
      </MenuItem>
      <MenuSeparator />
      <MenuItem id="sign-out" onAction={notYet('Signing out')}>
        Sign out
      </MenuItem>
    </Menu>
  );
}

function CommandTrigger(): ReactNode {
  const { toggleCommandBar } = useShell();
  // Shown as the keys people press; screen readers get them from aria-keyshortcuts.
  const [keys, setKeys] = useState('Ctrl K');
  useEffect(() => {
    if (/mac|iphone|ipad/i.test(navigator.userAgent)) setKeys('⌘K');
  }, []);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={(event) => {
        // Safari does not focus a clicked button, and focus must come back here on close.
        event.currentTarget.focus();
        toggleCommandBar();
      }}
      className="inline-flex h-control-md shrink-0 cursor-pointer items-center gap-8 rounded-sm text-secondary transition-colors duration-fast ease-enter hover:bg-hover hover:text-ink focus-visible:focus-ring max-sm:size-control-md max-sm:justify-center sm:border sm:border-rule-strong sm:px-8 md:w-shell-nav"
    >
      <IconSearch />
      {/* The name is the visible words, read even where only the icon shows. */}
      <span className="sr-only min-w-0 flex-1 truncate text-start md:not-sr-only md:truncate">
        Search or run a command
      </span>
      <kbd
        aria-hidden="true"
        className="hidden h-icon-md items-center rounded-xs border border-rule-strong px-4 font-sans text-label text-secondary sm:inline-flex"
      >
        {keys}
      </kbd>
    </button>
  );
}

export function TopBar({ data }: { data: ShellData }): ReactNode {
  const { drawerOpen, setDrawerOpen } = useShell();
  const here = parseShellPath(usePathname());
  const org = data.organization.slug;
  const project = here?.project === undefined ? undefined : data.projects[here.project];
  const product = PRODUCTS.find((p) => p.id === here?.product);
  const where = project?.name ?? product?.label ?? data.organization.name;
  const ref = useRef<HTMLElement>(null);
  const landmark = useLandmark(ref, { role: 'banner' });
  return (
    <header
      ref={ref}
      data-region="bar"
      {...landmark}
      className="sticky top-0 z-raised flex h-shell-bar items-center gap-4 border-b border-rule bg-ground ps-8 pe-12 outline-none focus-visible:focus-ring-inset"
    >
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={drawerOpen}
        aria-controls="shell-nav"
        data-drawer-trigger=""
        onClick={() => {
          setDrawerOpen(true);
        }}
        className={`${QUIET_ICON} sm:hidden`}
      >
        <IconMenu size="md" />
      </button>
      <Link
        href={`/${org}`}
        aria-label={`${data.organization.name} overview`}
        className="inline-grid size-control-md shrink-0 place-items-center rounded-sm text-ink transition-colors duration-fast ease-enter hover:bg-hover focus-visible:focus-ring"
      >
        <Mark />
      </Link>
      <span className="min-w-0 truncate font-medium text-ink sm:hidden">{where}</span>
      <div className="hidden items-center sm:flex">
        <OrganizationMenu data={data} />
      </div>
      <span
        aria-hidden="true"
        className="mx-8 hidden h-icon-md border-s border-rule-strong sm:block"
      />
      <div className="hidden h-full sm:block">
        <ProductsNav org={org} label="Products" opens={data.opens} variant="bar" />
      </div>
      <div className="ms-auto flex items-center gap-4">
        <CommandTrigger />
        <Inbox items={data.inbox} />
        <AccountMenu data={data} />
      </div>
    </header>
  );
}
