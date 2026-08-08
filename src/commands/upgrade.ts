import { copyFileSync, existsSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveTarget, stateFile, resolveAsset } from "../lib/paths.js";
import { logger } from "../lib/logger.js";
import { diffTree, type PkgInclude, type DiffPlan } from "../lib/diff.js";
import { createBackup } from "../lib/backup.js";
import {
  readAssetsVersion,
  readCliVersion,
  writeState,
  requireState,
  compareVersions,
  StateMissingError,
  type InstallState,
  type ChannelKey,
} from "../lib/version.js";
import { installCodegraph, installEntire } from "../lib/plugins/index.js";
import { copyDir } from "../lib/copy.js";
import { selfUpdate } from "../upgrade/self.js";
import type { Channels } from "../lib/ui.js";

const execFileAsync = promisify(execFile);

const NPM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — codegraph npm install can be slow
const EXEC_MAX_BUFFER = 64 * 1024 * 1024; // 64MB

export interface UpgradeOptions {
  target?: string;
  /** When true, delete files in target that are no longer in assets. */
  prune?: boolean;
  dryRun?: boolean;
  /** Skip the CLI self-update stage entirely. */
  noSelf?: boolean;
  with?: string;
  without?: string;
  /** Reserved for symmetry with install; upgrade has no interactive prompts today. */
  yes?: boolean;
}

/**
 * `pisquad upgrade` — sync a target install with the assets bundled in this
 * CLI package. See `docs/tasks/pisquad-cli/11-upgrade-command.md` for the full
 * behavioural contract.
 */
export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  const target = resolveTarget(options.target);
  const dryRun = options.dryRun === true;
  logger.info(`pisquad upgrade → ${target}${dryRun ? " (dry-run)" : ""}`);

  // 1. CLI self-update — if we actually upgraded the global CLI, the in-memory
  //    code is stale; tell the user to re-run and exit cleanly.
  let selfResult;
  try {
    selfResult = await selfUpdate({ logger, noSelf: options.noSelf });
  } catch (error) {
    logger.error(
      `CLI self-update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  if (selfResult.updated) {
    logger.success(
      "CLI self-updated to latest. Re-run `pisquad upgrade` to sync this project with the new version.",
    );
    return;
  }

  // 2. Require an existing install — legacy bash-installed projects have no
  //    state.json and must reinstall (PRD non-goal #1).
  let state: InstallState;
  try {
    state = requireState(target);
  } catch (error) {
    if (error instanceof StateMissingError) {
      logger.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // 3. Decide the post-upgrade channel set: state baseline + flags.
  let newChannels;
  try {
    newChannels = mergeChannels(state.channels, options);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const cliVersion = readCliVersion();
  const assetsVersion = readAssetsVersion();
  const versionDiff = compareVersions(state, {
    version: assetsVersion,
    cliVersion,
    channels: newChannels,
  });

  // 4. Build the diff include list (subtree granularity, never the whole .pi/).
  //    The includes are intentionally narrow so .pi/assets-version.txt and
  //    .pi/.gitignore (root files) never enter the diff.
  const includes: PkgInclude[] = [
    { pkgSubPath: ".pi/agents", targetSubPath: ".pi/agents" },
    { pkgSubPath: ".pi/skills", targetSubPath: ".pi/skills" },
    {
      pkgSubPath: ".pi/extensions/subagent",
      targetSubPath: ".pi/extensions/subagent",
    },
    {
      pkgSubPath: ".pi/extensions/wikilink-lint",
      targetSubPath: ".pi/extensions/wikilink-lint",
    },
    { pkgSubPath: "docs", targetSubPath: "docs" },
  ];
  if (newChannels.codegraph) {
    includes.push({
      pkgSubPath: ".pi/extensions/codegraph",
      targetSubPath: ".pi/extensions/codegraph",
    });
  }
  if (newChannels.entire) {
    includes.push({
      pkgSubPath: ".pi/extensions/entire",
      targetSubPath: ".pi/extensions/entire",
    });
  }

  // 5. Compute the diff plan.
  const plan = await diffTree(target, includes);

  if (versionDiff.versionChanged) {
    logger.info(`assets version: ${state.version} → ${assetsVersion}`);
  }
  if (versionDiff.cliVersionChanged) {
    logger.info(`CLI version: ${state.cliVersion} → ${cliVersion}`);
  }
  if (versionDiff.newChannels.length > 0) {
    logger.info(`new channels: ${versionDiff.newChannels.join(", ")}`);
  }
  if (versionDiff.removedChannels.length > 0) {
    logger.info(`removed channels: ${versionDiff.removedChannels.join(", ")}`);
  }

  // 6. Dry-run: print the plan and stop before any writes.
  if (dryRun) {
    printPlan(plan, options.prune === true);
    logger.info("DRY RUN — no changes made");
    return;
  }

  // 7. Back up files that will be overwritten (and, when pruning, deleted).
  const backupSet = new Set<string>();
  for (const m of plan.modified) backupSet.add(m.relPath);
  if (options.prune) {
    for (const r of plan.removed) backupSet.add(r.relPath);
  }
  if (backupSet.size > 0) {
    await createBackup(target, Array.from(backupSet).map((relPath) => ({ relPath })), "before-upgrade");
  }

  // 8-11. Apply changes, prune, run channel-specific work. Wrapped so any
  //       failure is surfaced cleanly with exit code 1 and the backup tarball
  //       left on disk for the user to inspect / restore manually.
  try {
    // 8. Apply modified + added by syncing each include subtree from assets.
    //    copyDir overwrites only files present in src, leaving extra files in
    //    dest alone — so user-added files survive unless --prune handles them
    //    explicitly below.
    for (const inc of includes) {
      const source = resolveAsset(inc.pkgSubPath);
      const destination = join(target, inc.targetSubPath);
      const isCodegraph = inc.pkgSubPath === ".pi/extensions/codegraph";
      copyDir(source, destination, {
        filter: isCodegraph
          ? (_abs, rel) => rel !== "node_modules" && rel !== "package-lock.json"
          : undefined,
        onSkip: (rel, reason) => logger.warn(`Skipped ${rel} (${reason})`),
      });
    }

    // 9. Handle removed files: default keep, --prune delete.
    if (options.prune) {
      for (const r of plan.removed) {
        const abs = join(target, r.relPath);
        try {
          rmSync(abs, { force: true });
        } catch (error) {
          logger.warn(
            `Failed to prune ${r.relPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // 10. Channel-specific handling.
    const codegraphNewlyEnabled = newChannels.codegraph && !state.channels.codegraph;
    const entireNewlyEnabled = newChannels.entire && !state.channels.entire;

    if (codegraphNewlyEnabled) {
      // installCodegraph does its own copy + npm install + codegraph init.
      // The copy we did in step 8 is redundant but harmless (writes the same
      // content) — we let installCodegraph own the full bootstrap.
      await installCodegraph(target, { logger });
    } else if (newChannels.codegraph) {
      // Already enabled. Re-run npm install only when the extension payload
      // actually changed (package.json etc.). Never re-run codegraph init —
      // the user's index lives there.
      const codegraphChanged =
        plan.modified.some((p) => p.relPath.startsWith(".pi/extensions/codegraph/")) ||
        plan.added.some((p) => p.relPath.startsWith(".pi/extensions/codegraph/"));
      if (codegraphChanged) {
        await runNpmInstall(join(target, ".pi", "extensions", "codegraph"));
      }
    }

    if (entireNewlyEnabled) {
      await installEntire(target, { logger });
    }

    // 11. codegraph.json: only copy when the target lacks one. We never
    //     overwrite the user's existing config (respect their customisation).
    //     When codegraph is newly enabled, installCodegraph already handles
    //     this; we only need to run the check for the pre-existing case.
    if (newChannels.codegraph && !codegraphNewlyEnabled) {
      const configDest = join(target, "codegraph.json");
      if (!existsSync(configDest)) {
        const configSource = resolveAsset("codegraph.json");
        if (existsSync(configSource)) {
          copyFileSync(configSource, configDest);
          logger.info(`copied codegraph.json → ${configDest}`);
        }
      } else {
        logger.info("codegraph.json already present, keeping user copy");
      }
    }
  } catch (error) {
    logger.error(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
    if (backupSet.size > 0) {
      logger.error(`backup retained on disk under .pi/.pisquad/backups/ for manual restore`);
    }
    process.exitCode = 1;
    return;
  }

  // 12. Persist new state.
  writeState(target, {
    version: assetsVersion,
    cliVersion,
    channels: newChannels,
    lastUpgradedAt: new Date().toISOString(),
  });

  // 13. Summary.
  printSummary({
    newChannels,
    backupCount: backupSet.size,
    backupPaths: [],
    removedCount: plan.removed.length,
    pruned: options.prune === true,
    statePath: stateFile(target),
    modifiedCount: plan.modified.length,
    addedCount: plan.added.length,
  });
}

async function runNpmInstall(cwd: string): Promise<void> {
  try {
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=warn"], {
      cwd,
      timeout: NPM_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`npm install in ${cwd} failed: ${message}`);
  }
}

function printPlan(plan: DiffPlan, prune: boolean): void {
  logger.info(`modified (${plan.modified.length}):`);
  for (const m of plan.modified) logger.info(`  M ${m.relPath}`);
  logger.info(`added (${plan.added.length}):`);
  for (const a of plan.added) logger.info(`  A ${a.relPath}`);
  logger.info(`removed (${plan.removed.length}):`);
  for (const r of plan.removed) logger.info(`  D ${r.relPath}${prune ? " (will delete)" : " (will keep)"}`);
  logger.info(`unchanged (${plan.unchanged.length})`);
  if (prune && plan.removed.length > 0) {
    logger.info(`Pruning will also back up the ${plan.removed.length} removed file(s) before deletion.`);
  }
}

interface Summary {
  newChannels: Channels;
  backupCount: number;
  backupPaths: string[];
  removedCount: number;
  pruned: boolean;
  statePath: string;
  modifiedCount: number;
  addedCount: number;
}

function printSummary(s: Summary): void {
  const parts = ["core"];
  if (s.newChannels.codegraph) parts.push("codegraph");
  if (s.newChannels.entire) parts.push("entire");
  logger.info(`Channels: ${parts.join(" + ")}`);
  logger.info(`Modified: ${s.modifiedCount}, added: ${s.addedCount}`);
  if (s.removedCount > 0) {
    if (s.pruned) {
      logger.info(`Removed: ${s.removedCount} (pruned)`);
    } else {
      logger.info(`Removed: ${s.removedCount} (kept — pass --prune to delete)`);
    }
  }
  if (s.backupCount > 0) {
    logger.info(`Backup: ${s.backupCount} file(s) archived`);
  }
  logger.info(`State: ${s.statePath}`);
  logger.success("upgrade complete");
}

// ---- channel merging ---------------------------------------------------------

function parseChannelList(input: string | undefined): Set<Exclude<ChannelKey, "core">> {
  const out = new Set<Exclude<ChannelKey, "core">>();
  if (!input) return out;
  for (const raw of input.split(",")) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (v === "codegraph" || v === "entire") out.add(v);
    else if (v !== "core") throw new Error(`Unknown channel: ${v}`);
  }
  return out;
}

/**
 * Merge `--with` / `--without` flags onto the state's existing channel set.
 *
 *   - state.channels is the baseline (no implicit changes).
 *   - `--with X` adds X to the baseline (idempotent).
 *   - `--without X` removes X from the baseline (idempotent).
 *   - `--with` and `--without` are mutually exclusive.
 *
 * `core` is always `true`; the schema pins it. The task spec uses this same
 * merge order so a later `pisquad upgrade --with codegraph` after a core-only
 * install adds the channel without re-prompting.
 */
function mergeChannels(base: Channels, options: { with?: string; without?: string }): Channels {
  const withSet = parseChannelList(options.with);
  const withoutSet = parseChannelList(options.without);
  if (withSet.size > 0 && withoutSet.size > 0) {
    throw new Error("Cannot combine --with and --without");
  }
  const next: Channels = {
    core: true,
    codegraph: base.codegraph,
    entire: base.entire,
  };
  if (withSet.size > 0) {
    for (const k of withSet) (next as unknown as Record<Exclude<ChannelKey, "core">, boolean>)[k] = true;
  }
  if (withoutSet.size > 0) {
    for (const k of withoutSet) (next as unknown as Record<Exclude<ChannelKey, "core">, boolean>)[k] = false;
  }
  return next;
}