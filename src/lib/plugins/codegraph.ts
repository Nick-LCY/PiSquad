import { copyDir } from "../copy.js";
import { resolveAsset } from "../paths.js";
import { atomicWriteFile } from "../fs-safe.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginOptions } from "./types.js";

const execFileAsync = promisify(execFile);

const NPM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const INIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Install the codegraph extension into the target.
 *
 * The extension ships with a `node_modules/` directory that should NOT be
 * shipped to consumers (size, platform mismatch, npm registry churn). Instead
 * we copy the source files + package.json + .gitignore and then run
 * `npm install` against the package.json to materialise dependencies.
 */
export async function installCodegraph(target: string, opts: PluginOptions): Promise<void> {
  const logger = opts.logger;
  const source = resolveAsset(".pi/extensions/codegraph");
  const destination = join(target, ".pi", "extensions", "codegraph");

  if (!existsSync(source)) {
    logger.warn(`Missing codegraph asset directory: ${source}`);
    return;
  }

  // Copy everything except node_modules / package-lock.json (lock is rebuilt by npm install).
  if (opts.dryRun) {
    copyDir(source, destination, {
      dryRun: true,
      filter: (_abs, rel) => rel !== "node_modules" && rel !== "package-lock.json",
    });
    logger.info(`[dry-run] npm install (skipped)`);
    logger.info(`[dry-run] codegraph init (skipped)`);
    return;
  }

  copyDir(source, destination, {
    filter: (_abs, rel) => rel !== "node_modules" && rel !== "package-lock.json",
  });
  logger.info(`copied extensions/codegraph`);

  // Ensure .gitignore pins node_modules.
  const gitignore = join(destination, ".gitignore");
  if (!existsSync(gitignore)) {
    atomicWriteFile(gitignore, "node_modules\n");
  }

  // Run npm install in the destination.
  try {
    logger.info(`running npm install (timeout ${NPM_TIMEOUT_MS / 1000}s)`);
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=warn"], {
      cwd: destination,
      timeout: NPM_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`codegraph npm install failed: ${message}`);
  }

  // codegraph init is best-effort: the user can run it manually later.
  if (!existsSync(join(target, ".codegraph"))) {
    try {
      logger.info(`running codegraph init (timeout ${INIT_TIMEOUT_MS / 1000}s)`);
      await execFileAsync("codegraph", ["init"], {
        cwd: target,
        timeout: INIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      logger.warn(`codegraph init failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      logger.warn(`run \`codegraph init\` inside ${target} manually before using codegraph tools`);
    }
  } else {
    logger.info(`.codegraph already present, skipping init`);
  }
}
