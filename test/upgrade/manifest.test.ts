import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { upgradeCommand } from "../../src/commands/upgrade.js";
import { writeState } from "../../src/lib/version.js";
import { EXTENSION_DIRS } from "../../src/lib/plugins/core.js";
import type { Channels } from "../../src/lib/ui.js";
import type { DecisionDeps } from "../../src/upgrade/decision.js";

/**
 * L4 · Core extension manifest shipped via `pisquad upgrade`
 * ------------------------------------------------------------
 *
 * Mirror of `test/install/core-extension-manifest.test.ts`, but on the
 * upgrade path. The 0.3.1 bug was that `bash-guard` was listed in the
 * `install` channel manifest (`src/lib/plugins/core.ts`'s `EXTENSION_DIRS`)
 * but missing from the `upgrade` diff includes array
 * (`src/commands/upgrade.ts`). The result: a fresh `pisquad install` got
 * `bash-guard`; a `pisquad upgrade` from an older install did not —
 * silent degradation of the timeout safety net.
 *
 * This test pins the contract for the upgrade path:
 *   1. Seed an empty target with a state.json describing an OLD install
 *      (so the diff is non-trivial and the upgrade goes through copy).
 *   2. Call `upgradeCommand` in-process with fake `DecisionDeps` that
 *      answer "adopt" for every interactive entry and `noSelf: true`
 *      so we never hit the network.
 *   3. Assert every core extension (derived from `EXTENSION_DIRS` so
 *      a future addition to the source-of-truth is automatically
 *      covered) is physically present under `<target>/.pi/extensions/`.
 *   4. Sanity-check bash-guard source survived intact.
 *
 * Red/green proof (no git stash needed):
 *   - If `.pi/extensions/bash-guard` is removed from `EXTENSION_DIRS`
 *     OR from the derived includes in `src/commands/upgrade.ts`, this
 *     test fails on the `bash-guard/index.ts missing under target`
 *     assertion. The includes loop in `upgradeCommand` only copies
 *     what the diff plan contains, and the diff plan only contains
 *     what's in the includes array — so the regression is caught at
 *     the upgrade boundary, not three layers deeper inside
 *     `installCore` or `copyDir`.
 *
 * Why this lives next to `test/install/core-extension-manifest.test.ts`
 * but as an in-process test (not a `spawnSync(node dist/bin.js upgrade
 * ...)` test)?
 *   - `upgrade` requires an existing state.json + channels baseline,
 *     so it can't be spawned against a virgin tmp dir the way `install
 *     --yes` can. Driving `upgradeCommand` directly with injected
 *     `DecisionDeps` is the same pattern `test/upgrade/integration.test.ts`
 *     uses, so we lean on the established scaffolding.
 *   - The install-side test exercises the built binary (catch-all for
 *     CLI / main.ts / tsup regressions); this upgrade-side test
 *     exercises the in-process logic. Together they bracket the
 *     install → upgrade boundary from both sides.
 *
 * The test deliberately does NOT depend on the system `tar` binary:
 * when the target is empty and the upgrade adopts everything, no
 * existing files need backing up, so `createBackup` is never invoked.
 * This keeps the test runnable on hosts without tar.
 */

function makeTempTarget(): string {
  return mkdtempSync(join(tmpdir(), "pisquad-upgrade-manifest-"));
}

/**
 * Seed an "old" install: state.json with prior assets + CLI versions
 * so the upgrade has a non-trivial version diff to print and the
 * state-write stage exercises a real transition. The target itself
 * is otherwise empty — meaning every core extension entry will be
 * classified as `added` by `diffTree` and routed through the copy
 * stage (which is exactly the code path the bug bypassed).
 */
function seedOldInstall(target: string, channels: Channels): void {
  writeState(target, {
    version: "0.2.0",
    cliVersion: "0.2.0",
    channels,
  });
}

/**
 * Decision deps that auto-adopt everything and never open an editor.
 * Mirrors `test/upgrade/integration.test.ts`'s all-adopt spy.
 */
function makeAutoAdoptDeps(): DecisionDeps {
  return {
    promptStrategy: async () => "all-adopt",
    promptFileDecision: async () => "adopt",
    openEditor: async () => "",
  };
}

/**
 * List the core extension directory names by stripping the
 * `extensions/` prefix from each `EXTENSION_DIRS` entry. This makes the
 * assertion automatically cover any future addition to the
 * single-source-of-truth (subagent, wikilink-lint, bash-guard, ...).
 */
function coreExtensionNames(): string[] {
  return Array.from(EXTENSION_DIRS).map((sub) => sub.replace(/^extensions\//, ""));
}

describe("L4 · core extension manifest ships via upgrade", () => {
  it(
    "upgradeCommand lands every core extension at <target>/.pi/extensions/ after an old-version upgrade",
    async () => {
      const target = makeTempTarget();
      const channels: Channels = { core: true, codegraph: false, entire: false };
      seedOldInstall(target, channels);

      // Sanity: the production source-of-truth must already include the
      // three known core extensions. If a future refactor drops one,
      // this assertion fails first — before any upgrade runs — so the
      // failure message is unambiguous.
      const names = coreExtensionNames();
      for (const required of ["subagent", "wikilink-lint", "bash-guard"]) {
        assert.ok(
          names.includes(required),
          `EXTENSION_DIRS must include ${required}; got [${names.join(", ")}]`,
        );
      }

      const deps = makeAutoAdoptDeps();
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

      // For each core extension, verify the directory + entry file
      // landed. This is the regression that motivated the test.
      const extRoot = join(target, ".pi", "extensions");
      for (const ext of names) {
        const entry = join(extRoot, ext, "index.ts");
        assert.equal(
          existsSync(entry),
          true,
          `${ext}/index.ts must ship under ${extRoot}/ after upgrade — ` +
            `regression: extension missing from upgrade includes array`,
        );
      }

      // Sanity check on the bash-guard copy specifically: its
      // `DEFAULT_BASH_TIMEOUT_S` constant must survive the round-trip
      // through `copyDir` so the upgraded copy is functional, not an
      // empty placeholder.
      const bashGuardSrc = join(extRoot, "bash-guard", "index.ts");
      const bashGuardContent = readFileSync(bashGuardSrc, "utf-8");
      assert.match(
        bashGuardContent,
        /DEFAULT_BASH_TIMEOUT_S/,
        "bash-guard source must contain its timeout constant after upgrade",
      );

      // Cleanup. Use rmSync with recursive to ensure nested dirs
      // (.pi/extensions/bash-guard, .pi/.pisquad, ...) are gone.
      rmSync(target, { recursive: true, force: true });
    },
  );

  it(
    "upgradeCommand lands every core extension even with --interactive + tty (managed path is non-interactive regardless)",
    async () => {
      // Defence in depth: the previous test exercises the
      // all-adopt / non-interactive branch. This test exercises the
      // --interactive + tty branch (forced via `forceInteractiveEnv`)
      // to make sure the per-file interactive loop also leaves the
      // core extensions alone — they are managed, so they must be
      // auto-adopted regardless of what the user picks for the
      // interactive files.
      //
      // We still skip the test on hosts without `tar`: an empty
      // target still goes through the decision layer, which doesn't
      // call createBackup; the only tar dependency would be if
      // somewhere along the way a backup kicks in (it doesn't here).
      // We borrow the integration test's `tarAvailable()` check so
      // the two suites stay aligned on what's runnable where.
      if (!tarAvailable()) return;
      const target = makeTempTarget();
      const channels: Channels = { core: true, codegraph: false, entire: false };
      seedOldInstall(target, channels);

      // Interactive deps that pick "keep" for every interactive file.
      // Managed extensions must still be auto-resolved.
      const deps: DecisionDeps = {
        promptStrategy: async () => "per-file",
        promptFileDecision: async () => "keep",
        openEditor: async () => "",
      };

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

      const extRoot = join(target, ".pi", "extensions");
      for (const ext of coreExtensionNames()) {
        assert.equal(
          existsSync(join(extRoot, ext, "index.ts")),
          true,
          `${ext}/index.ts must land even when interactive mode is forced and user picks "keep" everywhere`,
        );
      }

      rmSync(target, { recursive: true, force: true });
    },
  );
});

/** Local copy of the integration test's tar probe — kept here so the
 * two suites don't drift on what counts as a "skip" host. */
function tarAvailable(): boolean {
  try {
    execSync("tar --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}