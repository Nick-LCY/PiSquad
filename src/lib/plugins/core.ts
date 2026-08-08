import { copyDir } from "../copy.js";
import { resolveAsset } from "../paths.js";
import { atomicWriteFile } from "../fs-safe.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { PluginOptions } from "./types.js";

/**
 * Core-only extension directories. Only the always-on extensions ship with
 * the core channel. Optional extensions (codegraph, entire) are copied by
 * their own channel plugins (`installCodegraph`, `installEntire`) so that
 * `--yes` (core only) never copies code whose `node_modules` we cannot ship.
 */
const EXTENSION_DIRS = new Set([
  "extensions/subagent",
  "extensions/wikilink-lint",
]);

/**
 * Copy the "core" payload (agents, skills, only the always-on extensions
 * subagent + wikilink-lint source trees).
 *
 * The optional codegraph / entire extensions are NOT copied here — they are
 * installed by their own channel plugins when the user passes `--with`. This
 * keeps the core payload stable per the PRD decision "core locked, codegraph /
 * entire optional", and avoids shipping codegraph source without its
 * `node_modules` (which would break `import typebox` at pi load time).
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

  // Docs payload lives at assets/docs/ and is part of the core channel
  // (always installed). Consumers treat <target>/docs/ as the documentation
  // library template — see docs/conventions/.
  const docsSource = resolveAsset("docs");
  const docsDestination = join(target, "docs");
  const onSkip = (rel: string, reason: string): void => logger.warn(`Skipped ${rel} (${reason})`);
  if (!existsSync(docsSource)) {
    logger.warn(`Skipping missing asset directory: ${docsSource}`);
  } else if (opts.dryRun) {
    copyDir(docsSource, docsDestination, { dryRun: true });
    logger.info(`[dry-run] copy docs → docs`);
  } else {
    copyDir(docsSource, docsDestination, { onSkip });
    logger.info(`copied docs → docs`);
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
    const options: {
      filter: (_abs: string, rel: string) => boolean;
      dryRun?: boolean;
      onSkip?: (rel: string, reason: string) => void;
    } = {
      filter: (_abs: string, rel: string) => rel !== "node_modules" && rel !== "package-lock.json",
      onSkip: (rel: string, reason: string) => logger.warn(`Skipped ${rel} (${reason})`),
    };
    if (opts.dryRun) options.dryRun = true;
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
