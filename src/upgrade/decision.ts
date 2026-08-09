import { createHash } from "node:crypto";
import type { DiffPlan, PkgInclude } from "../lib/diff.js";
import { logger } from "../lib/logger.js";

/**
 * Pure coordination layer for `pisquad upgrade`.
 *
 * `resolveUpgradeActions` decides, for every entry in the `DiffPlan`,
 * whether the file should be:
 *
 *   - `adopt`        → copied from assets into the target (with backup first
 *                      for `modified`/`removed` that already exist on disk).
 *   - `keep`         → left untouched on disk. Used both for user-chosen
 *                      "keep my edits" picks and for `removed` entries when
 *                      `--prune` is not in play.
 *   - `edit`         → user opened `$EDITOR`, merged manually; the resulting
 *                      content is written back after copy and the file is
 *                      backed up (it contains the user's pre-edit version).
 *
 * The function is intentionally free of `inquirer` / `fs` / `child_process`
 * calls so it is unit-testable with fake `DecisionDeps`. The default
 * implementation lives in `decision-defaults.ts` and wires up the real
 * prompts + `diff` / editor.
 */

/** Kind of change the package is making to a file in the target. */
export type FileKind = "modified" | "added" | "removed";

/** User-confirmed outcome for a single file. */
export type FileDecision = "adopt" | "keep" | "edit";

/** Top-level strategy picked by the user before per-file decisions begin. */
export type StrategyMode = "all-adopt" | "all-keep" | "per-file";

/** A single entry in the plan, augmented with the include's interactive flag. */
export interface PlanEntry {
  relPath: string;
  kind: FileKind;
  fromHash?: string;
  toHash?: string;
  /** True when the include owning this file is user-editable territory. */
  interactive: boolean;
}

/** Result of a per-file `edit` decision. */
export interface EditResult {
  relPath: string;
  content: string;
  /**
   * True when the user saved content whose hex digest equals the new assets
   * version's hash. Surfaced in the upgrade summary so the user can see that
   * their edit collapsed back to "adopt new".
   */
  matchesTheirs: boolean;
}

/**
 * The aggregated output of the decision layer. Consumed by the upgrade
 * command to drive backup, copy, prune, edit-write-back, and summary.
 *
 * Sets partition the plan's file paths by intent:
 *
 *   - `entries`   — per-interactive-file decision map (excludes managed files).
 *   - `adopt`     — files whose content should be copied from assets (the
 *                   union of "managed modified/added" and "interactive adopt"
 *                   decisions, minus files handled by `editResults`).
 *   - `keep`      — files to leave alone. The copy filter MUST skip these
 *                   so the user's local copy survives.
 *   - `remove`    — files to delete (only populated when `--prune` is set and
 *                   the user confirmed the deletion).
 *   - `backup`    — files that must be archived before any write or delete.
 *                   Includes all `modified` + `removed` that exist on disk,
 *                   plus every `edit` file (whose tar contains the user's
 *                   pre-edit version).
 *   - `editResults` — write-back list, processed after copy so the staged
 *                   copy is overwritten with the user-edited content.
 */
export interface ResolvedPlan {
  entries: Map<string, FileDecision>;
  adopt: Set<string>;
  keep: Set<string>;
  remove: Set<string>;
  backup: Set<string>;
  editResults: EditResult[];
  mode: StrategyMode;
}

/** Inputs the caller must supply to drive a decision. */
export interface DecisionInput {
  plan: DiffPlan;
  includes: PkgInclude[];
  /**
   * The install target root. Required so the default adapter can read
   * `current` content for `edit` decisions. Decision.ts itself never reads
   * files; this field is forwarded to the adapter via `deps`.
   */
  target: string;
  prune: boolean;
  /**
   * Narrowed form of the raw `--interactive` / `--no-interactive` flag as
   * seen by the decision layer. The call site in `upgradeCommand` always
   * passes `options.interactive === true`, so the three meaningful values
   * reaching this layer are:
   *
   *   - `true`  → user passed `--interactive` (explicit opt-in).
   *   - `false` → EITHER the user passed `--no-interactive`, OR they
   *               passed no flag at all. These two cases are NOT
   *               distinguishable from this field alone; consult
   *               `interactiveSetByUser` to tell them apart. The
   *               decision logic in `shouldPrompt` does so explicitly.
   *
   * Combined with `isInteractiveEnv` and `yes` to decide whether any
   * prompt is fired.
   */
  interactive: boolean;
  /**
   * True when the user explicitly passed `--interactive` or `--no-interactive`.
   * Used so we can decide whether a non-interactive run was a deliberate
   * "I want batch behaviour" choice vs. a fallback from missing tty.
   */
  interactiveSetByUser: boolean;
  /** TTY + non-CI check from env.isInteractive(). */
  isInteractiveEnv: boolean;
  /** True when -y / --yes was passed; always suppresses prompts. */
  yes?: boolean;
}

/**
 * Test seam — every prompt, renderer, editor, env lookup, and hash function
 * is injectable. Production code calls `buildDefaultDecisionDeps()` from
 * `decision-defaults.ts`; tests pass fakes that record calls and return
 * scripted answers.
 */
export interface DecisionDeps {
  promptStrategy?: () => Promise<StrategyMode>;
  promptFileDecision?: (
    entry: PlanEntry,
    remaining: number,
    kind: FileKind,
  ) => Promise<FileDecision | "__adopt-all" | "__keep-all">;
  /**
   * Render the unified diff (or contents) for one interactive entry BEFORE
   * `promptFileDecision` is shown, so the user always sees what they're
   * about to decide on. The default adapter in `decision-defaults.ts`
   * resolves the absolute paths itself from the closures captured by
   * `buildDefaultDecisionDeps`; this layer only knows about `relPath` and
   * the file's `kind`.
   *
   *   - `modified` → unified diff from current to new.
   *   - `added`    → show the new file's full content.
   *   - `removed`  → show the file that would be deleted (or a notice).
   *
   * Optional — when not supplied (e.g. test deps that don't need the
   * preview) the diff step is silently skipped. Failures inside the
   * renderer are also swallowed (logged as a warn) so a missing-file
   * read or a system-`diff` crash never blocks the prompt path.
   */
  renderUnifiedDiff?: (relPath: string, kind: FileKind) => Promise<string>;
  /**
   * Open an editor on the user's copy of `relPath` and return the merged
   * content. The default adapter in `decision-defaults.ts` reads
   * `currentContent` from `<target>/<relPath>` and `newContent` from
   * `<assetsRoot>/<relPath>` itself; the empty-string sentinels from
   * `decision.ts` are placeholders the adapter ignores.
   */
  openEditor?: (relPath: string, currentContent: string, newContent: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  sha256Content?: (content: string) => string;
}

/** Default SHA-256 hex of an in-memory string. */
function defaultSha256Content(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Find the include that owns a target-relative path. */
function findInclude(includes: PkgInclude[], relPath: string): PkgInclude | undefined {
  // Match from longest targetSubPath first so ".pi/extensions/codegraph" wins
  // over ".pi" if both were ever registered. We don't currently do that, but
  // the sort makes the lookup robust against future changes.
  const sorted = [...includes].sort(
    (a, b) => b.targetSubPath.length - a.targetSubPath.length,
  );
  for (const inc of sorted) {
    if (!inc.targetSubPath) return inc;
    if (relPath === inc.targetSubPath) return inc;
    if (relPath.startsWith(`${inc.targetSubPath}/`)) return inc;
  }
  return undefined;
}

/**
 * Build the PlanEntry list from a DiffPlan + includes, flagging each entry
 * with the owning include's `interactive` setting.
 *
 * The diff's `fromHash` / `toHash` are preserved as-is so the decision layer
 * can reason about whether a file even exists on disk (removed) or in assets
 * (added).
 */
function entriesFromPlan(plan: DiffPlan, includes: PkgInclude[]): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const m of plan.modified) {
    const inc = findInclude(includes, m.relPath);
    entries.push({
      relPath: m.relPath,
      kind: "modified",
      fromHash: m.fromHash,
      toHash: m.toHash,
      interactive: inc?.interactive === true,
    });
  }
  for (const a of plan.added) {
    const inc = findInclude(includes, a.relPath);
    entries.push({
      relPath: a.relPath,
      kind: "added",
      toHash: a.toHash,
      interactive: inc?.interactive === true,
    });
  }
  for (const r of plan.removed) {
    const inc = findInclude(includes, r.relPath);
    entries.push({
      relPath: r.relPath,
      kind: "removed",
      fromHash: r.fromHash,
      interactive: inc?.interactive === true,
    });
  }
  // Keep the same order plan.modified/added/removed are sorted in (by relPath
  // alphabetically within each bucket) so per-file prompts are deterministic.
  return entries;
}

/**
 * Decide whether we should prompt the user at all. Three independent
 * suppressors short-circuit to the "no prompts → all-adopt" default:
 *
 *   1. `yes === true` (`--yes`).
 *   2. `interactiveSetByUser === true && interactive === false` (explicit
 *      `--no-interactive`).
 *   3. `isInteractiveEnv === false` (no tty / CI / PISQUAD_NO_TTY).
 *
 * When `interactiveSetByUser === false`, the caller-narrowed
 * `interactive === false` means the flag was absent, not that the user opted
 * out. If a tty is available, that combination proceeds to the interactive
 * flow; this is the implicit-interactive path required by ADR-0003 §5.
 */
function shouldPrompt(input: DecisionInput): boolean {
  if (input.yes === true) return false;
  // Only an EXPLICIT `--no-interactive` is treated as opt-out. When
  // the user did not pass the flag, `interactive` arrives as `false`
  // (the caller narrows via `options.interactive === true`); in that
  // case we must still consult `isInteractiveEnv` so a real tty
  // triggers the interactive flow per ADR-0003 §5.
  if (input.interactiveSetByUser && input.interactive === false) return false;
  return input.isInteractiveEnv;
}

/**
 * Compute the upgrade's action plan.
 *
 * The function is intentionally free of side effects beyond the supplied
 * `deps`. It does NOT read files, spawn editors, or write anything. Real I/O
 * is funnelled through `deps` so tests can drive every branch deterministically.
 */
export async function resolveUpgradeActions(
  input: DecisionInput,
  deps: DecisionDeps = {},
): Promise<ResolvedPlan> {
  const sha256Content = deps.sha256Content ?? defaultSha256Content;

  const empty: ResolvedPlan = {
    entries: new Map(),
    adopt: new Set(),
    keep: new Set(),
    remove: new Set(),
    backup: new Set(),
    editResults: [],
    mode: "all-adopt",
  };

  const allEntries = entriesFromPlan(input.plan, input.includes);
  if (allEntries.length === 0) return empty;

  const interactiveEntries = allEntries.filter((e) => e.interactive);
  const managedEntries = allEntries.filter((e) => !e.interactive);

  // 1. Managed (non-interactive) entries follow the legacy behaviour: modified
  //    overwrites (the legacy code path also backs them up), added copies, and
  //    removed is kept unless --prune is in play. None of these depend on the
  //    user-facing prompts, so we resolve them up front.
  for (const entry of managedEntries) {
    switch (entry.kind) {
      case "modified":
        empty.adopt.add(entry.relPath);
        empty.backup.add(entry.relPath);
        break;
      case "added":
        empty.adopt.add(entry.relPath);
        break;
      case "removed":
        if (input.prune) {
          empty.remove.add(entry.relPath);
          empty.backup.add(entry.relPath);
        } else {
          empty.keep.add(entry.relPath);
        }
        break;
    }
  }

  // 2. If there are no interactive entries, we're done. This is the common
  //    case for projects that only have extension-channel updates, and it
  //    keeps the upgrade behaviour identical to the pre-interactive version.
  if (interactiveEntries.length === 0) return empty;

  // 3. Decide the strategy. When we cannot prompt, default to all-adopt — that
  //    matches the legacy "no-tty → batch overwrite" behaviour and is also the
  //    command's documented non-interactive fallback.
  let mode: StrategyMode;
  if (!shouldPrompt(input)) {
    mode = "all-adopt";
  } else if (deps.promptStrategy === undefined) {
    // Should not happen in practice (the default deps always supply it), but
    // guard so the function is safe to call with `deps = {}`.
    mode = "all-adopt";
  } else {
    mode = await deps.promptStrategy();
  }
  empty.mode = mode;

  // 4. Apply the strategy to interactive entries.
  if (mode === "all-adopt") {
    for (const entry of interactiveEntries) {
      switch (entry.kind) {
        case "modified":
          empty.entries.set(entry.relPath, "adopt");
          empty.adopt.add(entry.relPath);
          empty.backup.add(entry.relPath);
          break;
        case "added":
          empty.entries.set(entry.relPath, "adopt");
          empty.adopt.add(entry.relPath);
          break;
        case "removed":
          // With --prune, "all-adopt" means "delete the file". The user's
          // intent is clear: they accepted the upgrade plan and want every
          // stale file gone. Without --prune we keep the file — the legacy
          // behaviour for "no prune" survives.
          if (input.prune) {
            empty.entries.set(entry.relPath, "adopt");
            empty.remove.add(entry.relPath);
            empty.backup.add(entry.relPath);
          } else {
            empty.entries.set(entry.relPath, "keep");
            empty.keep.add(entry.relPath);
          }
          break;
      }
    }
    return empty;
  }

  if (mode === "all-keep") {
    for (const entry of interactiveEntries) {
      switch (entry.kind) {
        case "modified":
        case "added":
        case "removed":
          empty.entries.set(entry.relPath, "keep");
          empty.keep.add(entry.relPath);
          break;
      }
    }
    return empty;
  }

  // 5. per-file: walk the entries in deterministic order, ask the user, and
  //    honour batch shortcuts that fan out to remaining entries.
  if (deps.promptFileDecision === undefined || deps.openEditor === undefined) {
    // Same fallback as above — if the caller asked for per-file but didn't
    // wire the prompt functions, we degrade to all-adopt rather than throw.
    for (const entry of interactiveEntries) {
      switch (entry.kind) {
        case "modified":
          empty.entries.set(entry.relPath, "adopt");
          empty.adopt.add(entry.relPath);
          empty.backup.add(entry.relPath);
          break;
        case "added":
          empty.entries.set(entry.relPath, "adopt");
          empty.adopt.add(entry.relPath);
          break;
        case "removed":
          if (input.prune) {
            empty.entries.set(entry.relPath, "adopt");
            empty.remove.add(entry.relPath);
            empty.backup.add(entry.relPath);
          } else {
            empty.entries.set(entry.relPath, "keep");
            empty.keep.add(entry.relPath);
          }
          break;
      }
    }
    return empty;
  }

  // Walk the interactive entries; track remaining = how many entries the user
  // has not yet seen, so batch shortcuts can advertise "Adopt all remaining
  // (N)". Index-based loop because we break out via the batch shortcuts.
  for (let i = 0; i < interactiveEntries.length; i++) {
    const entry = interactiveEntries[i]!;
    const remaining = interactiveEntries.length - i - 1;
    // `removed` entries without --prune cannot actually be deleted, so
    // prompting the user about a Delete/Keep choice would only produce
    // confusing no-ops. Auto-apply keep (matching the strategy-default and
    // managed-entry paths) and skip the prompt (and its diff preview)
    // entirely.
    if (entry.kind === "removed" && !input.prune) {
      empty.entries.set(entry.relPath, "keep");
      empty.keep.add(entry.relPath);
      continue;
    }
    // Render the file's diff / preview BEFORE firing the prompt, so the
    // user is never asked to choose blindly. Best-effort: if the dep is
    // missing (common in tests) we skip; if it throws we warn and fall
    // through to the prompt so the upgrade flow is never blocked.
    if (deps.renderUnifiedDiff !== undefined) {
      try {
        await deps.renderUnifiedDiff(entry.relPath, entry.kind);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `could not render diff for ${entry.relPath}: ${message} — skipping preview, proceeding to prompt`,
        );
      }
    }
    const answer = await deps.promptFileDecision(entry, remaining, entry.kind);
    if (answer === "__adopt-all" || answer === "__keep-all") {
      // Resolve the current entry with the batch decision, then fill the rest.
      const decision: FileDecision = answer === "__adopt-all" ? "adopt" : "keep";
      await applyInteractiveDecision(empty, entry, decision, deps, sha256Content, input.prune);
      for (let j = i + 1; j < interactiveEntries.length; j++) {
        await applyInteractiveDecision(
          empty,
          interactiveEntries[j]!,
          decision,
          deps,
          sha256Content,
          input.prune,
        );
      }
      return empty;
    }
    await applyInteractiveDecision(empty, entry, answer, deps, sha256Content, input.prune);
  }
  return empty;
}

/** Apply a single per-file decision to the in-progress plan. */
async function applyInteractiveDecision(
  plan: ResolvedPlan,
  entry: PlanEntry,
  decision: FileDecision,
  deps: DecisionDeps,
  sha256Content: (content: string) => string,
  prune: boolean,
): Promise<void> {
  plan.entries.set(entry.relPath, decision);
  if (decision === "keep") {
    plan.keep.add(entry.relPath);
    return;
  }
  if (decision === "adopt") {
    if (entry.kind === "removed") {
      // "adopt" for a removed file = "delete this file". Only honourable
      // when --prune is in play; otherwise we silently keep the user's copy
      // (the prompt defaults "Adopt" for removed entries to mean "delete",
      // so the user expects this behaviour even though their pick is
      // effectively no-op'd without --prune).
      if (prune) {
        plan.remove.add(entry.relPath);
        plan.backup.add(entry.relPath);
      } else {
        plan.keep.add(entry.relPath);
      }
      return;
    }
    plan.adopt.add(entry.relPath);
    if (entry.kind === "modified") {
      plan.backup.add(entry.relPath);
    }
    return;
  }
  // decision === "edit": invoke the editor via deps. openEditor is guaranteed
  // to exist here because the caller only enters per-file mode when it does.
  // (resolveUpgradeActions short-circuits to all-adopt otherwise.)
  const openEditor = deps.openEditor!;
  // currentContent / newContent are filled by the default adapter; tests can
  // supply a stub that ignores them and returns a canned string.
  const edited = await openEditor(entry.relPath, "", "");
  if (edited.length === 0) {
    // Empty editor result → treat as "keep my version". Surface this via
    // entries map (already set) and skip backup; the file is left alone.
    plan.keep.add(entry.relPath);
    return;
  }
  const matchesTheirs = typeof entry.toHash === "string" && sha256Content(edited) === entry.toHash;
  plan.editResults.push({ relPath: entry.relPath, content: edited, matchesTheirs });
  plan.backup.add(entry.relPath);
}