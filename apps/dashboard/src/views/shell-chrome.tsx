import type { ReactNode } from 'react';
import { fixtureIncidentsOn, startIncidentCommand } from '../incident/feed.ts';
import { IncidentLine } from '../incident/line.tsx';
import { IncidentProvider } from '../incident/provider.tsx';
import type { ShellData } from '../shell/data.ts';
import { ShellFrame } from '../shell/frame.tsx';
import { ShellMain } from '../shell/main.tsx';
import { Sidebar } from '../shell/sidebar.tsx';
import { TopBar } from '../shell/top-bar.tsx';

// The shell: skip link, top bar, sidebar and main. The bar and sidebar render from the
// layout at once and are never skeletons; only main waits for data.
export function ShellChrome({
  data,
  permissions,
  children,
}: {
  data: ShellData;
  permissions: readonly string[];
  children: ReactNode;
}): ReactNode {
  const org = data.organization.slug;
  const fixture = fixtureIncidentsOn(process.env);
  return (
    <ShellFrame
      org={org}
      orgName={data.organization.name}
      permissions={permissions}
      projects={data.projects}
      actions={fixture ? [startIncidentCommand(org)] : []}
    >
      <IncidentProvider org={org} permissions={permissions} fixture={fixture}>
        <a
          href="#main"
          data-skip=""
          className="fixed start-8 top-8 z-toast -translate-y-64 rounded-sm border border-rule-strong bg-overlay px-12 py-8 text-ink focus-visible:translate-y-0 focus-visible:focus-ring"
        >
          Skip to content
        </a>
        <TopBar data={data} />
        <IncidentLine />
        <div className="flex">
          <Sidebar data={data} />
          <ShellMain>{children}</ShellMain>
        </div>
      </IncidentProvider>
    </ShellFrame>
  );
}
