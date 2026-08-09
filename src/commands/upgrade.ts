import { copyFileSync, existsSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
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
import { resolveUpgradeActions, type ResolvedPlan } from "../upgrade/decision.js";
import { buildDefaultDecisionDeps } from "../upgrade/decision-defaults.js";
import { isInteractive } from "../lib/env.js";
import { ensureDir, atomicWriteFile } from "../lib/fs-safe.js";
import { ExitPromptError } from "@inquirer/core";
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
  /**
   * Explicit user request for interactive prompts. `true` is set by
   * `--interactive`; `false` by `--no-interactive`; `undefined` means
   * "default" — fall through to the tty + yes-based decision in
   * `upgradeCommand`.
   */
  interactive?: boolean;
  /**
   * True when the user explicitly passed `--interactive` or `--no-interactive`
   * on the command line. Distinguishes "user said no" from "user said
   * nothing, the upgrader defaulted". The decision layer uses this to know
   * whether it should warn when the tty-based fallback runs.
   */
  interactiveSetByUser?: boolean;
  /** Suppress all prompts and accept defaults (existing -y / --yes flag). */
  yes?: boolean;
  /**
   * @internal Test seam — pass fake `DecisionDeps` to drive every decision
   * branch without spawning real prompts or editors. Production code does
   * not set this; `buildDefaultDecisionDeps()` is used instead.
   */
  decisionDeps?: import("../upgrade/decision.js").DecisionDeps;
  /**
   * @internal Test seam — force `isInteractiveEnv` to a specific value
   * regardless of the host tty state. Production code does not set this.
   * Useful for integration tests that want to exercise the interactive
   * code path on CI hosts with no tty.
   */
  forceInteractiveEnv?: boolean;
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
  //
  //    `interactive: true` flags user-editable territory (docs, agents,
  //    skills). These are eligible for per-file prompts in
  //    `resolveUpgradeActions`. Extension packages are managed by the
  //    pisquad release process — they are always overwritten, never
  //    presented for per-file adoption.
  const includes: PkgInclude[] = [
    { pkgSubPath: ".pi/agents", targetSubPath: ".pi/agents", interactive: true },
    { pkgSubPath: ".pi/skills", targetSubPath: ".pi/skills", interactive: true },
    {
      pkgSubPath: ".pi/extensions/subagent",
      targetSubPath: ".pi/extensions/subagent",
    },
    {
      pkgSubPath: ".pi/extensions/wikilink-lint",
      targetSubPath: ".pi/extensions/wikilink-lint",
    },
    { pkgSubPath: "docs", targetSubPath: "docs", interactive: true },
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

  // 6. Dry-run: print the plan and stop before any writes. We still run
  //    `resolveUpgradeActions` here (in non-interactive mode) so the user
  //    sees a decision preview alongside the raw plan — counts of how many
  //    files would be adopted, kept, removed, and backed up under the
  //    active flags. `resolveUpgradeActions` is pure (no FS or editor side
  //    effects) so this is safe in dry-run. When the plan is empty we skip
  //    the decision layer entirely; there is nothing to summarise.
  if (dryRun) {
    const planIsEmpty =
      plan.modified.length === 0 && plan.added.length === 0 && plan.removed.length === 0;
    if (!planIsEmpty) {
      // Force non-interactive: no prompts will fire, the all-adopt default
      // applies, and we never call createBackup from this path.
      const dryRunDecision = await resolveUpgradeActions(
        {
          plan,
          includes,
          target,
          prune: options.prune === true,
          interactive: false,
          interactiveSetByUser: true,
          isInteractiveEnv: false,
          yes: true,
        },
        options.decisionDeps ?? buildDefaultDecisionDeps(target, resolveAsset("")),
      );
      const adoptCount = dryRunDecision.adopt.size;
      const keepCount = dryRunDecision.keep.size;
      const editCount = dryRunDecision.editResults.length;
      const backupCount = dryRunDecision.backup.size;
      const removeCount = dryRunDecision.remove.size;
      logger.info(
        `Would adopt: ${adoptCount} / keep: ${keepCount} / edit: ${editCount} / backup: ${backupCount} / remove: ${removeCount}`,
      );
    }
    printPlan(plan, options.prune === true);
    logger.info("DRY RUN — no changes made");
    return;
  }

  // 7. Run the decision layer. Interactive mode requires BOTH:
  //    a. The caller didn't pass `--no-interactive` or `--yes`.
  //    b. The host has a real tty (and is not CI / PISQUAD_NO_TTY).
  //
  //    Without both, we silently fall through to the all-adopt default —
  //    preserving the legacy "no tty → batch overwrite" behaviour. The
  //    decision layer is wrapped in its own try/catch so that a Ctrl-C
  //    inside @inquirer/prompts (an ExitPromptError) leaves the target
  //    untouched and exits with code 1.
  const isInteractiveEnv =
    options.yes !== true &&
    options.interactive !== false &&
    (options.forceInteractiveEnv === true || isInteractive());
  // Heads-up: the user explicitly asked for `--interactive` but we have no
  // tty (or they used `--yes`). Without this warning the command would
  // silently downgrade to batch adopt, which is surprising for someone
  // who reached for the flag. Skip the warning when forceInteractiveEnv
  // is in play (test seam) so CI-driven suites don't see noise.
  if (
    options.forceInteractiveEnv !== true &&
    options.interactiveSetByUser === true &&
    options.interactive === true &&
    !isInteractiveEnv
  ) {
    logger.warn(
      "--interactive ignored: no TTY detected, falling back to non-interactive (adopt-new) mode",
    );
  }
  let decision: ResolvedPlan;
  try {
    decision = await resolveUpgradeActions(
      {
        plan,
        includes,
        target,
        prune: options.prune === true,
        interactive: options.interactive === true,
        interactiveSetByUser: options.interactiveSetByUser === true,
        isInteractiveEnv,
        yes: options.yes === true,
      },
      options.decisionDeps ?? buildDefaultDecisionDeps(target, resolveAsset("")),
    );
  } catch (error) {
    // Distinguish two failure modes: a user-initiated cancellation (Ctrl-C
    // → @inquirer/core's ExitPromptError) is not a fault; surface it
    // honestly. Anything else is a real exception in the decision layer
    // (e.g. diff CLI failure, editor crash, FS error) — call it a failure
    // so the user can debug. Both still leave the target untouched
    // because the decision layer runs before the backup stage.
    const isUserCancel =
      error instanceof ExitPromptError ||
      (error instanceof Error && error.name === "ExitPromptError");
    if (isUserCancel) {
      logger.error("user cancelled — no changes made, no backup created");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`upgrade failed during decision: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  // 8. Back up files the decision layer flagged. Both `adopt` (existing files
  //    that will be overwritten) and `edit` (existing files we will overwrite
  //    post-merge) entries get archived so the user can always recover. We
  //    emit one tarball labelled "before-upgrade" — matching the legacy
  //    command's contract so existing restore tooling keeps working.
  //
  //    Wrapped in try/catch so a missing `tar` binary, full disk, or name
  //    collision produces a clean exit-1 instead of an unhandled rejection.
  //    On backup failure we must not proceed to the copy stage (the user
  //    has no recovery path otherwise) and the target is left untouched.
  const backupSet = decision.backup;
  let backupTarPath: string | null = null;
  if (backupSet.size > 0) {
    try {
      const backupResult = await createBackup(
        target,
        Array.from(backupSet).map((relPath) => ({ relPath })),
        "before-upgrade",
      );
      backupTarPath = backupResult.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`backup failed: ${message}`);
      logger.error(
        `no changes were made to ${target}; re-run once the issue is resolved`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // 9-12. Apply changes, prune, run channel-specific work. Wrapped so any
  //       failure is surfaced cleanly with exit code 1 and the backup tarball
  //       left on disk for the user to inspect / restore manually.
  try {
    // 9. Apply modified + added by syncing each include subtree from assets.
    //    copyDir overwrites only files present in src, leaving extra files in
    //    dest alone — so user-added files survive unless --prune handles them
    //    explicitly below.
    //
    //    The filter combines three concerns:
    //    - codegraph subtree skips node_modules and package-lock.json (would
    //      be restored by `npm install` anyway and copying is slow).
    //    - The decision layer's `keep` set is skipped so user-modified
    //      interactive files are NOT overwritten by the recursive copy.
    //    - Files handled by `editResults` are skipped here because step 10
    //      writes the user-merged content over the top of whatever the copy
    //      would have produced.
    for (const inc of includes) {
      const source = resolveAsset(inc.pkgSubPath);
      const destination = join(target, inc.targetSubPath);
      const isCodegraph = inc.pkgSubPath === ".pi/extensions/codegraph";
      copyDir(source, destination, {
        filter: (_abs, rel) => {
          const targetRel = inc.targetSubPath ? `${inc.targetSubPath}/${rel}` : rel;
          if (isCodegraph && (rel === "node_modules" || rel === "package-lock.json")) return false;
          if (decision.keep.has(targetRel)) return false;
          if (decision.editResults.some((e) => e.relPath === targetRel)) return false;
          return true;
        },
        onSkip: (rel, reason) => logger.warn(`Skipped ${rel} (${reason})`),
      });
    }

    // 10. Write back user-edited files. The recursive copy in step 9 staged
    //     the new assets version; we overwrite with the user's edited
    //     content here. Atomic write so a crash mid-write cannot corrupt
    //     the file. `matchesTheirs === true` means the user opened the
    //     editor, saw the new content, and saved it verbatim — i.e. they
    //     effectively chose "Adopt new" via the editor.
    for (const ed of decision.editResults) {
      const abs = join(target, ed.relPath);
      ensureDir(dirname(abs));
      atomicWriteFile(abs, ed.content);
      logger.info(
        `wrote edited ${ed.relPath}${ed.matchesTheirs ? " (matches new version — merged)" : " (user edit kept)"}`,
      );
    }

    // 11. Handle removed files: walk the decision's `remove` set (which only
    //     contains user-confirmed deletions when --prune is in play).
    for (const relPath of decision.remove) {
      const abs = join(target, relPath);
      try {
        rmSync(abs, { force: true });
      } catch (error) {
        logger.warn(
          `Failed to prune ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 12. Channel-specific handling. codegraph npm install runs only when
    //     the extension payload actually changed AND we adopted/edited
    //     something under .pi/extensions/codegraph/. We consult the
    //     decision layer's sets (not the raw plan) so a "keep my codegraph
    //     override" choice does not trigger a npm install that would clobber
    //     the kept file via package.json's deps update.
    const codegraphNewlyEnabled = newChannels.codegraph && !state.channels.codegraph;
    const entireNewlyEnabled = newChannels.entire && !state.channels.entire;

    if (codegraphNewlyEnabled) {
      // installCodegraph does its own copy + npm install + codegraph init.
      // The copy we did in step 9 is redundant but harmless (writes the same
      // content) — we let installCodegraph own the full bootstrap.
      await installCodegraph(target, { logger });
    } else if (newChannels.codegraph) {
      const codegraphTouched =
        Array.from(decision.adopt).some((p) =>
          p.startsWith(".pi/extensions/codegraph/"),
        ) ||
        decision.editResults.some((e) => e.relPath.startsWith(".pi/extensions/codegraph/"));
      if (codegraphTouched) {
        await runNpmInstall(join(target, ".pi", "extensions", "codegraph"));
      }
    }

    if (entireNewlyEnabled) {
      await installEntire(target, { logger });
    }

    // 13. codegraph.json: only copy when the target lacks one. We never
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

  // 14. Persist new state. We always write the latest assets version —
  //     even when the user chose "keep my version" for some files, so
  //     the package-side baseline is still current. Per-user overrides
  //     reappear in the next diff because their hashes differ from the
  //     assets' hashes; the warning at the end reminds the user of that.
  writeState(target, {
    version: assetsVersion,
    cliVersion,
    channels: newChannels,
    lastUpgradedAt: new Date().toISOString(),
  });

  // 15. Summary.
  const keptInteractive = Array.from(decision.entries.values()).filter(
    (d) => d === "keep",
  ).length;
  printSummary({
    newChannels,
    backupCount: backupSet.size,
    backupPaths: backupTarPath === null ? [] : [backupTarPath],
    removedCount: decision.remove.size,
    pruned: options.prune === true,
    statePath: stateFile(target),
    modifiedCount: plan.modified.length,
    addedCount: plan.added.length,
    adoptedCount: decision.adopt.size,
    keptCount: keptInteractive,
    editedCount: decision.editResults.length,
  });
  if (keptInteractive > 0) {
    logger.warn(
      `kept ${keptInteractive} user modification(s) — they will reappear in next upgrade's diff`,
    );
  }
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
  /** Number of files whose content was adopted from assets this run. */
  adoptedCount: number;
  /** Number of files the user explicitly chose to keep (interactive + --prune-deleted kept). */
  keptCount: number;
  /** Number of files the user edited in $EDITOR and wrote back. */
  editedCount: number;
}

function printSummary(s: Summary): void {
  const parts = ["core"];
  if (s.newChannels.codegraph) parts.push("codegraph");
  if (s.newChannels.entire) parts.push("entire");
  logger.info(`Channels: ${parts.join(" + ")}`);
  logger.info(`Modified: ${s.modifiedCount}, added: ${s.addedCount}`);
  logger.info(`Adopted: ${s.adoptedCount}, kept: ${s.keptCount}, edited: ${s.editedCount}`);
  if (s.removedCount > 0) {
    if (s.pruned) {
      logger.info(`Removed: ${s.removedCount} (pruned)`);
    } else {
      logger.info(`Removed: ${s.removedCount} (kept — pass --prune to delete)`);
    }
  }
  if (s.backupCount > 0) {
    logger.info(`Backup: ${s.backupCount} file(s) archived`);
    for (const p of s.backupPaths) logger.info(`  ${p}`);
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