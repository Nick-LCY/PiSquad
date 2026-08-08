import { copyDir } from "../copy.js";
import { resolveAsset } from "../paths.js";
import { atomicWriteFile } from "../fs-safe.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { PluginOptions } from "./types.js";

const EXTENSION_DIRS = new Set([
  "extensions/subagent",
  "extensions/wikilink-lint",
  "extensions/codegraph",
  "extensions/entire",
]);

/**
 * Copy the "core" payload (agents, skills, every extension's source tree).
 *
 * node_modules and package-lock.json are stripped from extension directories
 * during the core copy — `installCodegraph` materialises them via `npm install`
 * when the channel is enabled, and the entire/subagent/wikilink-lint extensions
 * have no runtime dependencies of their own.
 */
export async function installCore(target: string, opts: PluginOptions): Promise<void> {
  const logger = opts.logger;
  const baseAsset = resolveAsset(".pi");

  const simpleDirs = ["agents", "skills"];
  for (const sub of simpleDirs) {
    const source = join(baseAsset, sub);
    const destination = join(target, ".pi", sub);
    if (!existsSync(source)) {
      logger.warn(`Skipping missing asset directory: ${source}`);
      continue;
    }
    if (opts.dryRun) {
      copyDir(source, destination, { dryRun: true });
    } else {
      copyDir(source, destination);
    }
    logger.info(`copied ${sub} → .pi/${sub}`);
  }

  for (const sub of EXTENSION_DIRS) {
    const source = join(baseAsset, sub);
    const destination = join(target, ".pi", sub);
    if (!existsSync(source)) {
      if (opts.dryRun) {
        logger.info(`[dry-run] skip missing: assets/.pi/${sub}`);
      } else {
        logger.warn(`Skipping missing asset directory: ${source}`);
      }
      continue;
    }
    const options = {
      filter: (_abs: string, rel: string) => rel !== "node_modules" && rel !== "package-lock.json",
      ...(opts.dryRun ? { dryRun: true } : {}),
    };
    copyDir(source, destination, options);
    logger.info(`copied ${sub} → .pi/${sub}`);
  }

  // Pin the .pi/.gitignore so users do not accidentally check node_modules in.
  const gitignorePath = join(target, ".pi", ".gitignore");
  if (opts.dryRun) {
    logger.info(`[dry-run] write ${gitignorePath}`);
  } else if (!existsSync(gitignorePath)) {
    atomicWriteFile(gitignorePath, "node_modules\n");
  }
}
