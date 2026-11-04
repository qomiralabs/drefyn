import {
  IconCard,
  IconChart,
  IconCode,
  IconCommit,
  IconGlobe,
  IconHome,
  IconIncident,
  IconKey,
  IconLaptop,
  IconLock,
  IconPage,
  IconPerson,
  IconPulse,
  IconSchema,
  IconSettings,
  IconUsers,
} from '@drefyn/ui/react';
import type { CommandIcon } from './commands.ts';

// Package icons by the names the sidebar sections and the command registry use, so data
// can name an icon without importing components.
export const ICON_BY_NAME = {
  home: IconHome,
  page: IconPage,
  commit: IconCommit,
  code: IconCode,
  chart: IconChart,
  settings: IconSettings,
  incident: IconIncident,
  pulse: IconPulse,
  globe: IconGlobe,
  users: IconUsers,
  card: IconCard,
  key: IconKey,
  person: IconPerson,
  lock: IconLock,
  laptop: IconLaptop,
  schema: IconSchema,
} as const satisfies Record<CommandIcon, unknown>;
