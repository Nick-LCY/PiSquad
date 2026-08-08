import type { logger as LoggerModule } from "../logger.js";

export type Logger = typeof LoggerModule;

export interface PluginOptions {
  /** When true, plugins should report intended actions without performing them. */
  dryRun?: boolean;
  logger: Logger;
}

export type ChannelName = "core" | "codegraph" | "entire";
