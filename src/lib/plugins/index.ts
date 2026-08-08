import type { Channels } from "../ui.js";
import { logger as defaultLogger } from "../logger.js";
import type { Logger } from "./types.js";
import { installCore } from "./core.js";
import { installCodegraph } from "./codegraph.js";
import { installEntire } from "./entire.js";

export type { PluginOptions } from "./types.js";

export interface InstallChannelsOptions {
  dryRun?: boolean;
  logger?: Logger;
}

/**
 * Run the channel installation in the documented order: core first (always),
 * then the optional channels the caller requested.
 *
 * Throws when any required step fails. Optional steps (codegraph init, entire
 * enable) already log warnings internally rather than throwing.
 */
export async function installChannels(target: string, channels: Channels, options: InstallChannelsOptions = {}): Promise<void> {
  const logger = options.logger ?? defaultLogger;

  await installCore(target, { dryRun: options.dryRun, logger });

  if (channels.codegraph) {
    await installCodegraph(target, { dryRun: options.dryRun, logger });
  }

  if (channels.entire) {
    await installEntire(target, { dryRun: options.dryRun, logger });
  }
}

export { installCore, installCodegraph, installEntire };
