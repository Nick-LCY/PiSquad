import { program } from "../main.js";

/**
 * Print global or per-command help.
 * Falls back to commander's built-in help when no command name is given.
 */
export function helpCommand(commandName?: string): void {
  if (!commandName) {
    program.outputHelp();
    return;
  }

  const subcommand = program.commands.find((cmd) => cmd.name() === commandName || cmd.aliases().includes(commandName));
  if (!subcommand) {
    console.error(`Unknown command: ${commandName}`);
    program.outputHelp();
    return;
  }
  subcommand.outputHelp();
}
