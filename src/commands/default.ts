import { logger } from "../lib/logger.js";

/**
 * Default command handler.
 *
 * Commander's "no subcommand" hook is wired here so that running `pisquad`
 * with no arguments behaves like `pisquad install`.
 */
export async function defaultCommand(): Promise<void> {
  logger.step("default command → install");
  const { installCommand } = await import("./install.js");
  await installCommand({});
}
