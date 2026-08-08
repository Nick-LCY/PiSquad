import { Command } from "commander";
import { readCliVersion } from "./lib/version.js";
import { installCommand } from "./commands/install.js";
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
