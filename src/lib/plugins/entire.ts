import { copyDir } from "../copy.js";
import { resolveAsset } from "../paths.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginOptions } from "./types.js";

const execFileAsync = promisify(execFile);

const ENABLE_TIMEOUT_MS = 30 * 1000; // 30s — entire enable should be fast

/**
 * Install the entire extension into the target.
 *
 * This plugin fixes the long-standing bash installer bug where selecting the
 * "entire" channel only ran `entire enable --agent pi` without first copying
 * the extension source directory, leaving consumers with a half-installed
 * extension. Both steps now happen here, in this order:
 *
 *   1. Copy assets/.pi/extensions/entire → <target>/.pi/extensions/entire
 *   2. Run `entire enable --agent pi` (idempotent, best-effort)
 */
export async function installEntire(target: string, opts: PluginOptions): Promise<void> {
  const logger = opts.logger;
  const source = resolveAsset(".pi/extensions/entire");
  const destination = join(target, ".pi", "extensions", "entire");

  if (!existsSync(source)) {
    logger.warn(`Missing entire asset directory: ${source}`);
    return;
  }

  if (opts.dryRun) {
    copyDir(source, destination, { dryRun: true });
    logger.info(`[dry-run] entire enable --agent pi (skipped)`);
    return;
  }

  // Step 1: copy the extension directory (the bug fix).
  copyDir(source, destination);
  logger.info(`copied extensions/entire → ${destination}`);

  // Step 2: register with entire (best-effort — entire may not be installed yet).
  try {
    logger.info(`running entire enable --agent pi`);
    await execFileAsync("entire", ["enable", "--agent", "pi"], {
      cwd: target,
      timeout: ENABLE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    logger.warn(`entire enable --agent pi failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    logger.warn(`re-run \`entire enable --agent pi\` inside ${target} once Entire CLI is installed`);
  }
}
