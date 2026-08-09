import { Command } from "commander";
import { readCliVersion } from "./lib/version.js";
import { installCommand } from "./commands/install.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { versionCommand } from "./commands/version.js";
import { helpCommand } from "./commands/help.js";

export const program = new Command();

program
  .name("pisquad")
  .description("Install and upgrade the pi-squad development foundation")
  .version(readCliVersion(), "-V, --version", "Print version and exit");

program
  .command("install [path]")
  .description("Install pi-squad into the target directory (default: cwd)")
  .option("-y, --yes", "Skip prompts, install core only")
  .option("--with <channels>", "Comma-separated list of optional channels to install")
  .option("--without <channels>", "Comma-separated list of optional channels to skip")
  .option("--all", "Install every optional channel")
  .option("--dry-run", "Preview changes without writing anything")
  .action(async (pathArg: string | undefined, options: Record<string, unknown>) => {
    await installCommand({
      target: pathArg,
      yes: Boolean(options.yes),
      with: typeof options.with === "string" ? options.with : undefined,
      without: typeof options.without === "string" ? options.without : undefined,
      all: Boolean(options.all),
      dryRun: Boolean(options.dryRun),
    });
  });

program
  .command("upgrade [path]")
  .description("Upgrade an existing pi-squad install to match the current assets")
  .option("--prune", "Delete files in target that are no longer in assets (backed up first)")
  .option("--dry-run", "Preview the upgrade plan without writing anything")
  .option("--no-self", "Skip the CLI self-update stage")
  .option("--with <channels>", "Comma-separated list of optional channels to enable")
  .option("--without <channels>", "Comma-separated list of optional channels to disable")
  .option("-y, --yes", "Accept defaults without prompts (skip install channel prompts and upgrade interactive prompts)")
  .option("--interactive", "Force per-file interactive prompts (requires a tty)")
  .option("--no-interactive", "Skip interactive prompts even on a tty (batch adopt + backup)")
  .action(async (pathArg: string | undefined, options: Record<string, unknown>) => {
    // Commander's `--no-self` flag toggles `options.self` to `false`; the
    // conventional `options.noSelf` key is never set, so we check the negated
    // property directly here.
    const noSelf =
      options.noSelf === true ||
      options.self === false ||
      process.env.PISQUAD_NO_SELF === "1";
    // Interactive flag parsing: `--interactive` sets options.interactive = true;
    // `--no-interactive` sets options.interactive = false. We track which
    // case the user took so the decision layer can warn when the user
    // explicitly asked for non-interactive but we silently fell back.
    const interactive =
      options.interactive === true
        ? true
        : options.interactive === false
          ? false
          : undefined;
    const interactiveSetByUser = interactive !== undefined;
    await upgradeCommand({
      target: pathArg,
      prune: Boolean(options.prune),
      dryRun: Boolean(options.dryRun),
      noSelf,
      with: typeof options.with === "string" ? options.with : undefined,
      without: typeof options.without === "string" ? options.without : undefined,
      yes: Boolean(options.yes),
      interactive,
      interactiveSetByUser,
    });
  });

program
  .command("version")
  .description("Print CLI and assets versions")
  .action(() => {
    versionCommand();
  });

program
  .command("help [command]")
  .description("Show help for pisquad or one of its subcommands")
  .action((commandName?: string) => {
    helpCommand(commandName);
  });

// No-argument invocation forwards to install.
program.action(async () => {
  const { defaultCommand } = await import("./commands/default.js");
  await defaultCommand();
});

export async function run(argv: string[]): Promise<void> {
  await program.parseAsync(argv);
}
