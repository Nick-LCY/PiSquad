import { logger } from "../lib/logger.js";

export interface InstallOptions {
  target?: string;
  yes?: boolean;
  with?: string;
  without?: string;
  all?: boolean;
  dryRun?: boolean;
}

/**
 * Stub install command for task 05.
 * Full implementation lands in task 07.
 */
export async function installCommand(_options: InstallOptions): Promise<void> {
  logger.warn("install command is a stub (task 05); real logic arrives in task 07");
}
