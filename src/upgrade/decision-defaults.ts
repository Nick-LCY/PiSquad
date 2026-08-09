import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expand, editor } from "@inquirer/prompts";
import { execCapture as defaultExecCapture, which as defaultWhich } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type {
  DecisionDeps,
  FileKind,
  PlanEntry,
  StrategyMode,
} from "./decision.js";

/**
 * Default `DecisionDeps` for production use.
 *
 * Wires the real @inquirer/prompts `expand` and `editor` prompts plus the
 * `diff` CLI (with a read-and-print fallback when `diff` is not installed)
 * into the dependency-injected decision layer. Tests bypass this module
 * entirely and construct fake `DecisionDeps` to drive every branch.
 *
 * `target` and `assetsRoot` are stashed on the returned object so the
 * `openEditor` adapter can resolve absolute paths for the file it streams
 * into the editor. They are intentionally NOT used by `promptStrategy` or
 * `promptFileDecision` — those only need to know the per-file entry.
 */
export function buildDefaultDecisionDeps(
  target: string,
  assetsRoot: string,
  overrides: BuildDefaultDecisionDepsOptions = {},
): DecisionDeps {
  const which = overrides.which ?? defaultWhich;
  const execCapture = overrides.execCapture ?? defaultExecCapture;
  return {
    promptStrategy: defaultPromptStrategy,
    promptFileDecision: defaultPromptFileDecision,
    renderUnifiedDiff: (relPath, kind) =>
      defaultRenderUnifiedDiffForEntry(relPath, kind, {
        target,
        assetsRoot,
        which,
        execCapture,
      }),
    openEditor: (relPath: string) => defaultOpenEditor(relPath, target, assetsRoot),
    sha256Content: defaultSha256Content,
  };
}

/** Optional overrides for `buildDefaultDecisionDeps`. All fields default
 * to the real implementation from `lib/env.js`. Tests use these to inject
 * stubs (e.g. simulate a missing `diff` binary). */
export interface BuildDefaultDecisionDepsOptions {
  which?: (cmd: string) => string | null;
  execCapture?: typeof defaultExecCapture;
}

/**
 * Top-level strategy picker: batch-adopt (default), batch-keep, or per-file.
 *
 * Uses the @inquirer/prompts `expand` widget so the user picks a single
 * letter rather than navigating an arrow list. The legacy `default` key
 * (`1`) makes "Adopt new" the highlighted choice when the user just hits
 * enter — matching the documented behaviour for the non-interactive
 * fallback.
 */
async function defaultPromptStrategy(): Promise<StrategyMode> {
  const result = await expand({
    message: "Choose upgrade strategy for interactive files",
    default: "1",
    choices: [
      { key: "1", name: "Adopt new version for every file (recommended)", value: "all-adopt" },
      { key: "2", name: "Keep my current files (skip all updates)", value: "all-keep" },
      { key: "3", name: "Decide per file", value: "per-file" },
    ],
  });
  if (result === "all-adopt" || result === "all-keep" || result === "per-file") return result;
  // Defensive: should never happen given the choices above.
  return "all-adopt";
}

/**
 * Per-file decision prompt. The choices vary by `kind` because the user's
 * mental model is different for an existing-but-modified file vs. a brand
 * new file vs. one slated for deletion under --prune.
 *
 * When `remaining > 0` we append two batch shortcuts:
 *
 *   - `r` (Adopt all remaining N) — collapse every subsequent file to adopt.
 *   - `t` (Keep all remaining N) — collapse every subsequent file to keep.
 *
 * The sentinel values `__adopt-all` / `__keep-all` are recognised by
 * `resolveUpgradeActions` to fan the decision out and exit the per-file loop.
 */
type FileDecisionAnswer = "adopt" | "keep" | "edit" | "__adopt-all" | "__keep-all";

async function defaultPromptFileDecision(
  entry: PlanEntry,
  remaining: number,
  kind: FileKind,
): Promise<FileDecisionAnswer> {
  const header = describeEntry(entry);
  // Track which key is the default so we can label it in the choice name.
  // inquirer's `expand` highlights the default key in the prompt UI, but
  // the choice name itself stays plain text — appending "(default)" makes
  // it explicit in non-interactive contexts (CI logs, screen readers, etc.).
  const defaultKey: "a" | "k" | "e" = kind === "modified" ? "k" : "a";
  const label = (key: "a" | "k" | "e", name: string): string =>
    key === defaultKey ? `${name} (default)` : name;
  const baseChoices: Array<{ key: "a" | "k" | "e"; name: string; value: FileDecisionAnswer }> =
    kind === "modified"
      ? [
          { key: "a", name: label("a", "Adopt new version"), value: "adopt" },
          { key: "k", name: label("k", "Keep my version"), value: "keep" },
          { key: "e", name: label("e", "Edit / merge manually in $EDITOR"), value: "edit" },
        ]
      : kind === "added"
        ? [
            { key: "a", name: label("a", "Adopt new file"), value: "adopt" },
            { key: "k", name: label("k", "Skip (don't add this file)"), value: "keep" },
          ]
        : [
            { key: "a", name: label("a", "Delete (--prune)"), value: "adopt" },
            { key: "k", name: label("k", "Keep my file"), value: "keep" },
          ];

  const batchChoices: Array<{ key: "r" | "t"; name: string; value: FileDecisionAnswer }> =
    remaining > 0
      ? [
          {
            key: "r",
            name: `Adopt all remaining (${remaining})`,
            value: "__adopt-all",
          },
          {
            key: "t",
            name: `Keep all remaining (${remaining})`,
            value: "__keep-all",
          },
        ]
      : [];

  const answer = await expand<FileDecisionAnswer>({
    message: header,
    default: defaultKey,
    choices: [...baseChoices, ...batchChoices],
  });
  if (answer === "__adopt-all" || answer === "__keep-all") return answer;
  if (answer === "adopt" || answer === "keep" || answer === "edit") return answer;
  // Defensive: fall back to keep if the prompt somehow returns an unknown value.
  return "keep";
}

function describeEntry(entry: PlanEntry): string {
  const verb = entry.kind === "modified" ? "modified" : entry.kind === "added" ? "added" : "removed";
  return `${entry.relPath} (${verb})`;
}

/**
 * Render a unified diff for the file. Uses the system `diff` CLI when
 * available; otherwise prints the new version's full content under a clear
 * header so the user can still review what would land.
 *
 * Returns the rendered string (also printed to the upgrade log) so callers
 * that want to keep the diff around — e.g. for a `--diff-out` flag — can
 * consume it without re-running `diff`.
 *
 * This is the low-level helper that powers `defaultRenderUnifiedDiffForEntry`
 * (the kind-aware adapter wired into `DecisionDeps`). It is exported so
 * tests can exercise the `diff`/`readFileSync` fallback paths without
 * having to mock the whole `DecisionDeps` surface.
 */
async function defaultRenderUnifiedDiff(
  relPath: string,
  fromAbs: string,
  toAbs: string,
  deps: { which: (cmd: string) => string | null; execCapture: typeof defaultExecCapture } = {
    which: defaultWhich,
    execCapture: defaultExecCapture,
  },
): Promise<string> {
  logger.info(`--- unified diff for ${relPath} ---`);
  if (deps.which("diff") !== null) {
    const result = await deps.execCapture("diff", ["-u", fromAbs, toAbs]);
    const stdout = result.stdout.trim();
    if (stdout.length === 0) {
      logger.info("(files are identical)");
      return "";
    }
    for (const line of stdout.split(/\r?\n/)) logger.info(line);
    if (result.exitCode > 1) {
      // diff exits 1 when files differ — expected. > 1 means actual error.
      logger.warn(`diff exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
    return stdout;
  }
  // Fallback: print the new version in full so the user can still review.
  logger.info("(diff CLI not found; showing new version in full)");
  logger.info("New version from assets:");
  const newContent = readFileSync(toAbs, "utf-8");
  for (const line of newContent.split(/\r?\n/)) logger.info(line);
  return newContent;
}

export { defaultRenderUnifiedDiff };

/**
 * Kind-aware adapter for the per-file diff preview that the decision
 * layer fires BEFORE `promptFileDecision`. Resolves the file kind to the
 * appropriate view using the closures captured by
 * `buildDefaultDecisionDeps`:
 *
 *   - `modified` → unified diff (`diff -u <fromAbs> <toAbs>`) with the
 *      existing fallback when the system `diff` CLI is missing.
 *   - `added`    → just print the new file's contents (there's nothing
 *      to diff against).
 *   - `removed`  → print the file that would be deleted (or a notice
 *      when it's already gone from disk).
 *
 * Errors reading individual files are logged as warnings and the preview
 * returns an empty string — the decision layer swallows the empty
 * response and proceeds to the prompt. This matches requirement #5 of
 * the diff-preview wiring (render failure must not block the prompt).
 */
async function defaultRenderUnifiedDiffForEntry(
  relPath: string,
  kind: FileKind,
  ctx: {
    target: string;
    assetsRoot: string;
    which: (cmd: string) => string | null;
    execCapture: typeof defaultExecCapture;
  },
): Promise<string> {
  if (kind === "modified") {
    const fromAbs = join(ctx.target, relPath);
    const toAbs = join(ctx.assetsRoot, relPath);
    return defaultRenderUnifiedDiff(relPath, fromAbs, toAbs, {
      which: ctx.which,
      execCapture: ctx.execCapture,
    });
  }
  if (kind === "added") {
    const toAbs = join(ctx.assetsRoot, relPath);
    logger.info(`--- new file ${relPath} ---`);
    let content: string;
    try {
      content = readFileSync(toAbs, "utf-8");
    } catch (error) {
      logger.warn(
        `could not read new version of ${relPath}: ${
          error instanceof Error ? error.message : String(error)
        } — skipping preview`,
      );
      return "";
    }
    for (const line of content.split(/\r?\n/)) logger.info(line);
    return content;
  }
  // kind === "removed"
  const oldAbs = join(ctx.target, relPath);
  logger.info(`--- ${relPath} (no longer exists in new version) ---`);
  try {
    const content = readFileSync(oldAbs, "utf-8");
    logger.info("Current content (would be removed when --prune is in effect):");
    for (const line of content.split(/\r?\n/)) logger.info(line);
    return content;
  } catch {
    logger.info("(this file no longer exists on disk either)");
    return "";
  }
}

export { defaultRenderUnifiedDiffForEntry };

/**
 * Open the user's editor on the current file and return whatever they
 * saved. Falls back to logging a warning and returning an empty string
 * (which `resolveUpgradeActions` treats as "keep my version") if the editor
 * is missing or exits non-zero.
 *
 * We pass `waitForUserInput: true` so the prompt does not return until the
 * user closes their editor — without this, @inquirer/editor would resolve
 * immediately with the unchanged default and the user would see nothing
 * happen.
 */
async function defaultOpenEditor(
  relPath: string,
  target: string,
  assetsRoot: string,
): Promise<string> {
  const currentPath = join(target, relPath);
  const newPath = join(assetsRoot, relPath);
  let current = "";
  try {
    current = readFileSync(currentPath, "utf-8");
  } catch (error) {
    logger.warn(
      `could not read current version of ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let incoming = "";
  try {
    incoming = readFileSync(newPath, "utf-8");
  } catch (error) {
    logger.warn(
      `could not read new version of ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logger.info(`--- editing ${relPath} ---`);
  logger.info("New version from assets:");
  for (const line of incoming.split(/\r?\n/)) logger.info(line);
  logger.info("--- end of new version; opening $EDITOR with current content as default ---");

  try {
    const edited = await editor({
      message: `Edit ${relPath} (close the editor when done; an empty file means "keep my version")`,
      default: current,
      postfix: ".md",
      waitForUserInput: true,
    });
    return edited;
  } catch (error) {
    logger.warn(
      `editor failed for ${relPath}: ${error instanceof Error ? error.message : String(error)} — keeping current version`,
    );
    return "";
  }
}

/** Default SHA-256 hex of an in-memory string. */
function defaultSha256Content(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}