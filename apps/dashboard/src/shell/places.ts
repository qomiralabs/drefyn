import { allowed, defineCommands, type Command, type CommandIcon } from './commands.ts';
import type { ShellData, ShellProject } from './data.ts';
import type { ProductId } from './products.ts';

const PROJECT_LOOK: Readonly<Record<ProductId, { icon: CommandIcon; kind: string }>> = {
  docs: { icon: 'page', kind: 'Docs project' },
  studio: { icon: 'schema', kind: 'Studio project' },
  status: { icon: 'pulse', kind: 'status page' },
};

// The server sent only projects this person reaches, and a role on one project grants no
// product permission, so organization read is all the bar should ask for here.
const projectPlace = (org: string, key: string, project: ShellProject): Command => ({
  id: `project-${key}`,
  name: project.name,
  ...PROJECT_LOOK[project.product],
  ...(project.state === undefined ? {} : { state: project.state }),
  href: `/${org}/${key}`,
  permission: 'org.read',
});

// Places the shell knows without asking a server, so they work even when search is down.
export function places(org: string, projects: ShellData['projects']): readonly Command[] {
  const at = (path: string) => `/${org}${path}`;
  return defineCommands([
    {
      id: 'overview',
      icon: 'home',
      name: 'Overview',
      kind: 'organization',
      href: at(''),
      permission: 'org.read',
      shortcut: 'G O',
    },
    {
      id: 'docs',
      icon: 'page',
      name: 'Docs',
      kind: 'product',
      href: at('/docs'),
      permission: 'docs.read',
      shortcut: 'G 1',
    },
    {
      id: 'studio',
      icon: 'schema',
      name: 'Studio',
      kind: 'product',
      href: at('/studio'),
      permission: 'studio.read',
      shortcut: 'G 2',
    },
    {
      id: 'status',
      icon: 'pulse',
      name: 'Status',
      kind: 'product',
      href: at('/status'),
      permission: 'status.read',
      shortcut: 'G 3',
    },
    ...Object.entries(projects).map(([key, project]) => projectPlace(org, key, project)),
    {
      id: 'plan',
      icon: 'card',
      name: 'Plan and usage',
      kind: 'organization',
      keywords: ['billing', 'limits'],
      href: at('/settings/plan'),
      permission: 'org.read',
    },
    {
      id: 'members',
      icon: 'users',
      name: 'Members',
      kind: 'organization',
      keywords: ['seats', 'invite'],
      href: at('/settings/members'),
      permission: 'org.read',
    },
    {
      id: 'api-keys',
      icon: 'key',
      name: 'API keys',
      kind: 'organization',
      keywords: ['tokens', 'ci'],
      href: at('/settings/api-keys'),
      permission: 'org.read',
    },
    {
      id: 'settings',
      icon: 'settings',
      name: 'Organization settings',
      kind: 'organization',
      href: at('/settings'),
      permission: 'org.read',
    },
    {
      id: 'account',
      icon: 'person',
      name: 'Profile and email',
      kind: 'your account',
      href: '/account',
      permission: 'org.read',
    },
    {
      id: 'sign-in-methods',
      icon: 'lock',
      name: 'Sign in methods',
      kind: 'your account',
      keywords: ['password', 'github', 'google'],
      href: '/account/sign-in',
      permission: 'org.read',
    },
    {
      id: 'sessions',
      icon: 'laptop',
      name: 'Sessions',
      kind: 'your account',
      keywords: ['sign out', 'browsers'],
      href: '/account/sessions',
      permission: 'org.read',
    },
  ]);
}

// What the bar offers this person. It only hides: the server refuses the rest on its own.
export function visiblePlaces(
  org: string,
  permissions: readonly string[],
  projects: ShellData['projects'],
): readonly Command[] {
  const held = new Set(permissions);
  return allowed(places(org, projects), (permission) => held.has(permission));
}
