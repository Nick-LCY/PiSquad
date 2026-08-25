import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * L4 · Core extension manifest shipped via `pisquad install`
 * ------------------------------------------------------------
 *
 * The core channel advertises three always-on extensions: subagent,
 * wikilink-lint, and bash-guard. The first two have been on the manifest
 * since the CLI shipped; bash-guard was promoted to "core" in 0.3.0
 * (alongside the idle-suspension arbitration work) and the install
 * manifest in `src/lib/plugins/core.ts` (`EXTENSION_DIRS`) was missed.
 *
 * Without bash-guard in the manifest, `pisquad install --yes` lands a
 * target whose `.pi/extensions/` only contains subagent + wikilink-lint.
 * A consumer who then runs the agent sees no timeout hints on bash
 * tool calls and no system-prompt runtime note about the default —
 * silently degrading the safety net that the 0.3.0 release notes
 * promised.
 *
 * This test pins the contract end-to-end:
 *   1. Spawn the freshly-built `dist/bin.js install --yes <tmp-target>`.
 *   2. Assert the three core extensions are physically present under
 *      `<tmp-target>/.pi/extensions/`.
 *   3. Sanity-check the bash-guard source survived the copy intact
 *      (its `DEFAULT_BASH_TIMEOUT_S` constant is in the file).
 *
 * Why exercise the built binary instead of importing `installCore`
 * from src/?
 *   - It catches the full production path: CLI argv parsing → main.ts
 *     dispatch → installCommand → installCore → copyDir. A regression
 *     in any layer (e.g. someone refactors main.ts and accidentally
 *     drops the `--yes` short-circuit, or the tsup bundle stops
 *     embedding the assets lookup) flips this test red.
 *   - The user constraint says "L4 测试用的 dist 必须是新鲜构建", so
 *     the test reads `process.cwd()/dist/bin.js` and refuses to fall
 *     back to tsx — keeping the red/green logic honest.
 *
 * Red/green proof (no git stash needed):
 *   - If `extensions/bash-guard` is removed from `EXTENSION_DIRS` in
 *     `src/lib/plugins/core.ts`, the install loop in `installCore`
 *     iterates only `subagent` + `wikilink-lint`. The first assertion
 *     below fails with `bash-guard/index.ts missing under target`,
 *     making the regression visible at the install boundary — not
 *     three layers deeper inside `installCore`.
 *   - Conversely, with bash-guard restored, all three assertions pass.
 *
 * Why a dedicated test/install/ dir?
 *   - The integration test under `test/upgrade/` exercises the
 *     upgrade decision layer (DecisionDeps). It never spawns the
 *     dist binary. Putting L4 in its own directory makes the contract
 *     discoverable: anything under `test/install/` runs the built CLI.
 */

function resolveDistBin(): string {
  const binPath = resolve(process.cwd(), "dist", "bin.js");
  if (!existsSync(binPath)) {
    throw new Error(
      `dist/bin.js not found at ${binPath}. Run \`npm run build\` first; L4 requires a fresh build.`,
    );
  }
  const stat = statSync(binPath);
  if (!stat.isFile()) {
    throw new Error(`dist/bin.js exists but is not a regular file: ${binPath}`);
  }
  return binPath;
}

/** Spawn `node dist/bin.js install --yes <target>` and capture stdout+stderr. */
function runInstall(target: string): { status: number; stdout: string; stderr: string } {
  const bin = resolveDistBin();
  const result = spawnSync(process.execPath, [bin, "install", "--yes", target], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("L4 · core extension manifest ships via install --yes", () => {
  it("copies subagent, wikilink-lint, and bash-guard into <target>/.pi/extensions/", () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-l4-manifest-"));
    let proc: ReturnType<typeof runInstall> | undefined;
    try {
      proc = runInstall(target);

      // Sanity: install must exit 0. A non-zero status would mask the
      // assertion failures below (e.g. missing assets dir would throw
      // inside copyDir). Surface it first so the test message is
      // actionable.
      assert.equal(
        proc.status,
        0,
        `pisquad install --yes must exit 0\nstdout: ${proc.stdout}\nstderr: ${proc.stderr}`,
      );

      const extRoot = join(target, ".pi", "extensions");
      assert.equal(existsSync(extRoot), true, ".pi/extensions/ must exist after install");

      // The two pre-existing core extensions — these are control
      // assertions to make sure the test isn't satisfied by a no-op
      // install (e.g. dry-run leaking through).
      for (const ext of ["subagent", "wikilink-lint"]) {
        assert.equal(
          existsSync(join(extRoot, ext, "index.ts")),
          true,
          `core extension "${ext}" must ship under ${extRoot}/`,
        );
      }

      // The new entry — this is the regression that motivated L4.
      const bashGuardPath = join(extRoot, "bash-guard", "index.ts");
      assert.equal(
        existsSync(bashGuardPath),
        true,
        `bash-guard extension must ship under ${extRoot}/ (regression: EXTENSION_DIRS missed this entry in 0.3.0)`,
      );

      // Source content survived the copy intact. If someone replaces
      // the asset tree with a placeholder, this fails loudly.
      const content = readFileSync(bashGuardPath, "utf-8");
      assert.match(
        content,
        /DEFAULT_BASH_TIMEOUT_S/,
        "bash-guard source must contain its timeout constant — copy may have corrupted the file",
      );

      // Subagent extension: semantic-token assertions on the WIP
      // usage-surfacing + transcript payload (0.3.2). We assert
      // the FEATURES, not the exact export signature — a future
      // refactor that re-organizes the module (e.g. moves the
      // transcript renderer into a sibling file) shouldn't trip
      // L4. The shipped behavior the LLM / consumer sees must be:
      //   - aggregateUsageToUsage exists and sums cost.total
      //   - appendUsageLines exists and renders per-agent usage
      //   - renderTranscript exists and renders a [transcript] header
      // This is the mirror of the "no fixture mirror" rule from
      // [[conventions/release-verification.md]]: we pin the
      // semantic contract, not the byte-for-byte layout.
      const subagentPath = join(extRoot, "subagent", "index.ts");
      const subagentContent = readFileSync(subagentPath, "utf-8");
      assert.match(
        subagentContent,
        /\baggregateUsageToUsage\b/,
        "subagent/index.ts must export aggregateUsageToUsage — 0.3.2 usage-surfacing WIP",
      );
      assert.match(
        subagentContent,
        /\bappendUsageLines\b/,
        "subagent/index.ts must export appendUsageLines — 0.3.2 usage-surfacing WIP",
      );
      assert.match(
        subagentContent,
        /\brenderTranscript\b/,
        "subagent/index.ts must export renderTranscript — 0.3.2 transcript WIP",
      );
      assert.match(
        subagentContent,
        /cost\.total/,
        "subagent/index.ts must surface cost.total in aggregateUsageToUsage — 0.3.2 cost aggregation",
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
      // Surface proc for any test runner that captures locals.
      void proc;
    }
  });
});