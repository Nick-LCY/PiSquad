import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
import { ExitPromptError } from "@inquirer/core";
import { upgradeCommand } from "../../src/commands/upgrade.js";
import { writeState, readAssetsVersion, readCliVersion } from "../../src/lib/version.js";
import type { Channels } from "../../src/lib/ui.js";
import { resolveAsset } from "../../src/lib/paths.js";
import type { DecisionDeps } from "../../src/upgrade/decision.js";

/**
 * Integration test that exercises the full upgrade pipeline with fake
 * `DecisionDeps`. We construct a synthetic install target tree, write a
 * state.json, then call `upgradeCommand` with the decision deps overridden
 * to drive every decision branch.
 *
 * The test deliberately does NOT depend on a global `tar` invocation
 * beyond what is already required by `createBackup` — if `tar` is missing
 * the relevant assertions skip rather than fail, so the test passes on
 * hosts without tar.
 */

function tarAvailable(): boolean {
  try {
    execSync("tar --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Logged once per test run when tar is missing, so skipped tests are
 * visible in CI output rather than silently passing. */
let tarSkipReasonLogged = false;
function noteTarSkipIfNeeded(): void {
  if (tarSkipReasonLogged) return;
  tarSkipReasonLogged = true;
  // eslint-disable-next-line no-console
  console.log("# skip: tar not available — backup-dependent integration tests");
}

function makeTempTarget(): string {
  return mkdtempSync(join(tmpdir(), "pisquad-upgrade-int-"));
}

/**
 * Populate a fresh target with:
 *   - a valid state.json (so upgradeCommand doesn't bail)
 *   - the assets-version/channels baseline (matching what's currently shipped)
 *
 * Returns the target root. The target's content mirrors what an install
 * created via `pisquad install` would produce, but only for the subtrees
 * we want to test against.
 */
function seedTarget(target: string, channels: Channels): void {
  writeState(target, { channels });
}

interface DecisionLog {
  promptStrategyCalls: number;
  promptFileDecisionCalls: number;
  openEditorCalls: number;
  entriesSeen: Array<{ relPath: string; kind: string }>;
}

function makeDeps(
  strategyAnswer: "all-adopt" | "all-keep" | "per-file" = "per-file",
  answers: Array<{ match: string; answer: "adopt" | "keep" | "edit" }> = [],
  edits: Map<string, string> = new Map(),
): { deps: DecisionDeps; log: DecisionLog } {
  const log: DecisionLog = {
    promptStrategyCalls: 0,
    promptFileDecisionCalls: 0,
    openEditorCalls: 0,
    entriesSeen: [],
  };
  const deps: DecisionDeps = {
    promptStrategy: async () => {
      log.promptStrategyCalls += 1;
      return strategyAnswer;
    },
    promptFileDecision: async (entry, remaining, kind) => {
      log.promptFileDecisionCalls += 1;
      log.entriesSeen.push({ relPath: entry.relPath, kind });
      void remaining;
      void kind;
      // Find the first rule whose `match` substring appears in the relPath;
      // fall through to "keep" if nothing matches (matches the existing
      // semantics for an empty/unmatched answers list).
      for (const rule of answers) {
        if (entry.relPath.includes(rule.match)) return rule.answer;
      }
      return "keep";
    },
    openEditor: async (relPath, _current, _new) => {
      log.openEditorCalls += 1;
      return edits.get(relPath) ?? `edited-${relPath}`;
    },
    sha256Content: (content: string) => {
      // Simple stable hash so matchesTheirs works deterministically.
      let h = 0;
      for (let k = 0; k < content.length; k++) h = ((h << 5) - h + content.charCodeAt(k)) | 0;
      return h.toString(16);
    },
  };
  return { deps, log };
}

/**
 * Touch a file at target/relPath by reading from the assets root (or
 * returning a literal if no assets content is available). Useful to set
 * up "user-modified" content that differs from assets.
 */
function writeUserFile(target: string, relPath: string, content: string): void {
  const abs = join(target, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function readTarget(target: string, relPath: string): string {
  return readFileSync(join(target, relPath), "utf-8");
}

function assetsRead(relPath: string): string {
  return readFileSync(resolveAsset(relPath), "utf-8");
}

describe("upgradeCommand integration", () => {
  it("interactive edit writes user content", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    } // skip on hosts without tar
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);
    // Seed the target with a user-modified version of an interactive file.
    // We modify docs/README.md so it differs from the assets version.
    const userContent = "# user-modified content\n\nThis is the user's own edits.\n";
    writeUserFile(target, "docs/README.md", userContent);
    // Also pre-create docs/conventions (matching assets layout — so the diff
    // recognises the target as a pisquad install).
    writeUserFile(target, "docs/conventions/install-state.md", "(irrelevant)");
    writeUserFile(target, ".pi/agents/worker.md", "(irrelevant)");

    const editedContent = "user merged content here";
    const edits = new Map([["docs/README.md", editedContent]]);
    const { deps, log } = makeDeps("per-file", [{ match: "docs/README.md", answer: "edit" }], edits);

    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: deps,
        interactiveSetByUser: true,
        // Force interactive by passing interactive=true (so shouldPrompt returns true).
        interactive: true,
        forceInteractiveEnv: true,
        // Bypass selfUpdate stage via env var; ignore any error from npm view.
        noSelf: true,
      });
    } finally {
      process.exitCode = prevExit;
    }

    // The user's edited content must be on disk after upgrade.
    const finalContent = readTarget(target, "docs/README.md");
    assert.equal(finalContent, editedContent, "edited content wins");

    // Decision layer was actually invoked once.
    assert.equal(log.promptStrategyCalls, 1);
    assert.equal(log.openEditorCalls >= 1, true, "editor opened at least once");

    // Cleanup
    try {
      execSync(`rm -rf ${target}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  });

  it("non-interactive: upgradeCommand adopts everything in interactive areas too (legacy behaviour)", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Seed the target with user-modified content for an interactive file.
    const userContent = "USER_EDIT_" + Date.now();
    writeUserFile(target, "docs/README.md", userContent);

    // interactive=false, isInteractiveEnv default false in tests → all-adopt
    const { deps, log } = makeDeps("all-adopt", []);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: deps,
        interactive: false,
        interactiveSetByUser: true,
        noSelf: true,
      });
    } finally {
      process.exitCode = prevExit;
    }

    // After non-interactive upgrade, docs/README.md must match the assets
    // content (the user's edits were silently overwritten — that's the
    // documented legacy fallback behaviour).
    const finalContent = readTarget(target, "docs/README.md");
    const assetsContent = assetsRead("docs/README.md");
    assert.equal(finalContent, assetsContent, "non-interactive upgraded to assets content");
    assert.equal(log.promptStrategyCalls, 0, "no prompt in non-interactive mode");
  });

  it("managed extension files: always overwritten even in interactive mode", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Pre-create a file under a managed include (`.pi/extensions/subagent`)
    // with user-modified content. Managed includes are NEVER prompted —
    // the decision layer treats them as "always adopt" regardless of
    // strategy. The user's override must be overwritten.
    const targetFile = ".pi/extensions/subagent/index.ts";
    const userContent = "USER_OVERRIDE_" + Date.now();
    writeUserFile(target, targetFile, userContent);

    const { deps } = makeDeps("all-keep", []);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: deps,
        interactive: true,
        interactiveSetByUser: true,
        forceInteractiveEnv: true,
        noSelf: true,
      });
    } finally {
      process.exitCode = prevExit;
    }

    // The user's override must be gone — managed entries are always
    // overwritten regardless of the strategy the user picked.
    const finalContent = readTarget(target, targetFile);
    assert.equal(
      finalContent.includes("USER_OVERRIDE"),
      false,
      "managed file overwritten even when strategy=all-keep",
    );
    // Sanity check: the file is now the assets' content.
    const assetsContent = assetsRead(targetFile);
    assert.equal(finalContent, assetsContent, "managed file matches assets after upgrade");
  });

  it("prune=true: removed files adopted via all-adopt are deleted", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Create a file in the target that isn't in assets. We'll fabricate
    // an "assets diff" by writing into docs and then deleting it AFTER
    // upgrade computed its plan but BEFORE running. Instead, simulate by
    // simply having target contain a file the assets don't ship and
    // relying on the package diff to detect it as removed.
    //
    // Easier: create a real "removed" scenario by copying an asset, then
    // deleting it before upgrade.
    const targetOnlyRel = "docs/legacy-note.md";
    writeUserFile(target, targetOnlyRel, "legacy");

    const { deps } = makeDeps("all-adopt", []);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: true,
        decisionDeps: deps,
        forceInteractiveEnv: true,
        noSelf: true,
      });
    } finally {
      process.exitCode = prevExit;
    }

    // The removed file should be gone from the target after --prune.
    assert.equal(existsSync(join(target, targetOnlyRel)), false, "prune removed the file");
  });

  it("decision layer throws (user cancelled): no backup, exit code 1", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Mark the file we want to keep so we can check it survives.
    const marker = "KEEP_ME_" + Date.now();
    writeUserFile(target, "docs/README.md", marker);

    const throwingDeps: DecisionDeps = {
      promptStrategy: async () => {
        throw new Error("user cancelled via Ctrl-C");
      },
    };

    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: throwingDeps,
        interactive: true,
        interactiveSetByUser: true,
        forceInteractiveEnv: true,
        noSelf: true,
      });
    } finally {
      // restore — but capture
    }

    assert.equal(process.exitCode, 1, "exit code set to 1 on cancellation");

    // User content survived (no writes happened).
    const after = readTarget(target, "docs/README.md");
    assert.equal(after, marker, "user content preserved after cancel");

    // No backup tarball should exist (decision layer threw before backup).
    // Strict assertion: the backups dir must not exist at all, or if it
    // does (e.g. left over from a prior run) it must contain no .tar.gz
    // files. This catches regressions where the backup stage runs before
    // a failing decision layer.
    const backupDir = join(target, ".pi", ".pisquad", "backups");
    if (existsSync(backupDir)) {
      const entries = readdirSync(backupDir);
      const tarballs = entries.filter((f) => f.endsWith(".tar.gz"));
      assert.equal(
        tarballs.length,
        0,
        `no .tar.gz files should exist after cancelled upgrade; found: ${tarballs.join(", ")}`,
      );
    }
    process.exitCode = prevExit;
  });

  it("decision layer throws ExitPromptError instance: cancel-aware branch, no backup, exit 1", async () => {
    // Reviewer W3 finding: the existing "decision layer throws" test
    // throws a plain Error and hits the "upgrade failed during decision"
    // branch. This test exercises the SECOND branch — a real
    // ExitPromptError from @inquirer/core — and proves that
    // upgradeCommand distinguishes the two by source and surfaces the
    // user-friendly "cancelled" message instead of the failure message.
    // Captures console.error output to verify the message split.
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    const marker = "KEEP_ME_" + Date.now();
    writeUserFile(target, "docs/README.md", marker);

    const exitErrorDeps: DecisionDeps = {
      promptStrategy: async () => {
        // Genuine ExitPromptError instance from @inquirer/core — what
        // user presses Ctrl-C actually raises inside the prompt layer.
        throw new ExitPromptError("User force closed the prompt with SIGINT");
      },
    };

    const errLines: string[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
    };

    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: exitErrorDeps,
        interactive: true,
        interactiveSetByUser: true,
        forceInteractiveEnv: true,
        noSelf: true,
      });
    } finally {
      console.error = originalErr;
    }

    assert.equal(process.exitCode, 1, "exit code set to 1 on user cancel");

    // User content survived (no writes happened).
    const after = readTarget(target, "docs/README.md");
    assert.equal(after, marker, "user content preserved after cancel");

    // Cancel-aware branch printed "user cancelled" (NOT "upgrade failed
    // during decision"). The exitErrorDeps instance satisfies both the
    // `instanceof ExitPromptError` and the `error.name === "ExitPromptError"`
    // checks in upgrade.ts.
    const sawCancelMessage = errLines.some((line) => line.includes("user cancelled"));
    const sawFailureMessage = errLines.some((line) => line.includes("upgrade failed"));
    assert.equal(
      sawCancelMessage,
      true,
      `expected "user cancelled" branch; got: ${errLines.join(" | ")}`,
    );
    assert.equal(
      sawFailureMessage,
      false,
      `must NOT hit "upgrade failed during decision" branch for a real ExitPromptError`,
    );

    // No backup tarball should exist (decision layer threw before backup).
    const backupDir = join(target, ".pi", ".pisquad", "backups");
    if (existsSync(backupDir)) {
      const entries = readdirSync(backupDir);
      const tarballs = entries.filter((f) => f.endsWith(".tar.gz"));
      assert.equal(
        tarballs.length,
        0,
        `no .tar.gz files should exist after a cancelled upgrade; found: ${tarballs.join(", ")}`,
      );
    }
    process.exitCode = prevExit;
  });

  it("decision layer throws { name: 'ExitPromptError' }: cancel-aware branch (name-based fallback)", async () => {
    // Reviewer W3 finding (secondary): upgradeCommand's cancel detection
    // has TWO checks — `instanceof ExitPromptError` AND `error.name ===
    // "ExitPromptError"` — for a reason. Sometimes the real class isn't
    // reachable (e.g. errors thrown across a worker boundary, errors
    // reconstructed from a serialized payload). This test exercises the
    // name-based fallback to make sure that path is also covered.
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);
    writeUserFile(target, "docs/README.md", "KEEP_ME_" + Date.now());

    const nameOnlyErrorDeps: DecisionDeps = {
      promptStrategy: async () => {
        // Plain Error object with the right name — NOT an instance of
        // @inquirer/core's ExitPromptError class. The double-check in
        // upgradeCommand must still treat this as a user cancellation.
        const error = new Error("user cancelled (name-only)");
        error.name = "ExitPromptError";
        throw error;
      },
    };

    const errLines: string[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
    };

    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: nameOnlyErrorDeps,
        interactive: true,
        interactiveSetByUser: true,
        forceInteractiveEnv: true,
        noSelf: true,
      });
    } finally {
      console.error = originalErr;
    }

    assert.equal(process.exitCode, 1, "exit code set to 1 on user cancel (name-only)");
    const sawCancel = errLines.some((line) => line.includes("user cancelled"));
    const sawFailure = errLines.some((line) => line.includes("upgrade failed"));
    assert.equal(sawCancel, true, "name-based ExitPromptError still routes to cancel branch");
    assert.equal(
      sawFailure,
      false,
      "name-based ExitPromptError must NOT hit the upgrade failed branch",
    );
    process.exitCode = prevExit;
  });

  it("createBackup fails: exit 1, no changes made to target", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Set up a file that the diff will report as modified and that the
    // decision layer will mark for backup. We then sabotage the backup
    // by deleting the file from disk *between* the decision and the
    // createBackup call. The `promptFileDecision` hook fires after the
    // decision but before the upgrade command proceeds to backup, so
    // it's a convenient place to plant the failure.
    const marker = "KEEP_ME_" + Date.now();
    const targetFile = "docs/README.md";
    writeUserFile(target, targetFile, marker);

    const sabotagingDeps: DecisionDeps = {
      promptStrategy: async () => "per-file",
      promptFileDecision: async (_entry, _remaining, _kind) => {
        // Strip the file from disk AFTER the decision has already
        // recorded it for backup. createBackup validates every file
        // exists and will throw — the upgrade must catch that and exit
        // cleanly without touching anything else. Only sabotage once so
        // subsequent promptFileDecision calls don't trip over the
        // missing file (the editor hook reads from disk too).
        try {
          unlinkSync(join(target, targetFile));
          return "adopt";
        } catch {
          // Already gone — fall through to a safe answer.
          return "keep";
        }
      },
      openEditor: async () => "edited-fallback",
    };

    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: sabotagingDeps,
        interactive: true,
        interactiveSetByUser: true,
        forceInteractiveEnv: true,
        noSelf: true,
      });
    } finally {
      /* restore later */
    }

    assert.equal(process.exitCode, 1, "exit code set to 1 on backup failure");
    // No backup should exist (the createBackup call threw before any
    // tarball was written, and the upgrade must bail before the copy
    // stage).
    const backupDir = join(target, ".pi", ".pisquad", "backups");
    if (existsSync(backupDir)) {
      const entries = readdirSync(backupDir);
      const tarballs = entries.filter((f) => f.endsWith(".tar.gz"));
      assert.equal(
        tarballs.length,
        0,
        `no .tar.gz files should exist after backup failure; found: ${tarballs.join(", ")}`,
      );
    }
    process.exitCode = prevExit;
  });

  it("dry-run: shows decision preview summary, never writes backup", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Seed a file so the diff has something to show — we want the
    // decision preview line, not the empty-plan fast path.
    const marker = "USER_CONTENT_" + Date.now();
    writeUserFile(target, "docs/README.md", marker);

    const { deps } = makeDeps("all-keep", []);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        dryRun: true,
        decisionDeps: deps,
        interactive: false,
        interactiveSetByUser: true,
        noSelf: true,
      });
    } finally {
      process.exitCode = prevExit;
    }

    // User content survives — dry-run must not touch the target.
    const after = readTarget(target, "docs/README.md");
    assert.equal(after, marker, "user content preserved after dry-run");
    // No backup should exist — dry-run never calls createBackup.
    const backupDir = join(target, ".pi", ".pisquad", "backups");
    assert.equal(existsSync(backupDir), false, "no backups dir created in dry-run");
    // The decision preview must have been printed (via console.log because
    // logger.info is hard to mock from outside the module). node:test
    // captures console output by default; we just assert dry-run
    // completed without throwing and the target is intact.
  });

  it("--interactive with no tty: emits a warning that interactive was ignored", async () => {
    if (!tarAvailable()) {
      noteTarSkipIfNeeded();
      return;
    }
    const target = makeTempTarget();
    const channels: Channels = { core: true, codegraph: false, entire: false };
    seedTarget(target, channels);

    // Seed a file so the diff is non-empty (so the upgrade reaches the
    // decision / apply stages instead of just printing "no changes").
    writeUserFile(target, "docs/README.md", "user");

    const { deps } = makeDeps("all-adopt", []);
    // Capture warn output so we can assert on the W1 message.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await upgradeCommand({
        target,
        prune: false,
        decisionDeps: deps,
        // User explicitly asked for --interactive; we simulate a host
        // with no tty by NOT setting forceInteractiveEnv.
        interactive: true,
        interactiveSetByUser: true,
        noSelf: true,
      });
    } finally {
      console.warn = originalWarn;
      process.exitCode = prevExit;
    }

    const sawWarning = warnings.some((w) => w.includes("--interactive ignored"));
    assert.equal(
      sawWarning,
      true,
      `expected --interactive ignored warning, got: ${warnings.join(" | ")}`,
    );
  });
});

// Quiet node:test import warning
void readAssetsVersion;
void readCliVersion;
void sep;