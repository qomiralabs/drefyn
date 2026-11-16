import { AUTH_COMMAND_USAGE, runAuthCommand } from '@drefyn/auth/command';
import { MAINTAIN_USAGE, MIGRATE_USAGE, runMaintain, runMigrate } from '@drefyn/db/command';

export interface Output {
  write(text: string): void;
}

export interface CommandOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: Output;
  readonly stderr: Output;
}

export interface Commands {
  readonly migrate: (options: CommandOptions) => Promise<number>;
  readonly auth: (options: CommandOptions) => Promise<number>;
  readonly maintain: (options: CommandOptions) => Promise<number>;
}

export interface RunDrefynOptions extends CommandOptions {
  // Tests stub these; the binary uses the real ones.
  readonly commands?: Commands;
}

const REAL: Commands = { migrate: runMigrate, auth: runAuthCommand, maintain: runMaintain };
const EXIT_USAGE = 2;

// Dispatch on the first word only. Each command parses the full argv itself, so its own
// usage and exit codes stay exactly what its package tests pin.
export async function runDrefyn(options: RunDrefynOptions): Promise<number> {
  const { commands = REAL, ...command } = options;
  const word = command.argv[0];
  if (word === 'migrate') return commands.migrate(command);
  if (word === 'auth') return commands.auth(command);
  if (word === 'maintain') return commands.maintain(command);
  command.stderr.write(`${MIGRATE_USAGE}\n${AUTH_COMMAND_USAGE}\n${MAINTAIN_USAGE}\n`);
  return EXIT_USAGE;
}
