import type { ReactNode } from 'react';
import { PLACEHOLDER_SHELL } from '../../fixtures/shell.ts';
import { guardOrganization } from '../../server/guard.ts';
import { ShellFrame } from '../../shell/frame.tsx';
import { ShellMain } from '../../shell/main.tsx';
import { Sidebar } from '../../shell/sidebar.tsx';
import { TopBar } from '../../shell/top-bar.tsx';

// The shell: skip link, top bar, sidebar and main. The bar and sidebar render from the
// layout at once and are never skeletons; only main waits for data.
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const organization = await guardOrganization(org);
  return (
    <ShellFrame org={org} orgName={organization.name}>
      <a
        href="#main"
        data-skip=""
        className="fixed start-8 top-8 z-toast -translate-y-64 rounded-sm border border-rule-strong bg-overlay px-12 py-8 text-ink focus-visible:translate-y-0 focus-visible:focus-ring"
      >
        Skip to content
      </a>
      <TopBar data={PLACEHOLDER_SHELL} />
      <div className="flex">
        <Sidebar data={PLACEHOLDER_SHELL} />
        <ShellMain>{children}</ShellMain>
      </div>
    </ShellFrame>
  );
}
