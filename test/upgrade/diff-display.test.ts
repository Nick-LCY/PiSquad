import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultRenderUnifiedDiff,
  defaultRenderUnifiedDiffForEntry,
} from "../../src/upgrade/decision-defaults.js";

/**
 * `renderUnifiedDiff` must keep working when the system `diff` CLI is
 * absent (CI sandboxes, alpine base images, etc.). We force the fallback by
 * injecting a `which` stub that returns null, and verify the function
 * still returns the new version's content for downstream consumption.
 */
describe("defaultRenderUnifiedDiff", () => {
  it("falls back to readFileSync when diff CLI is missing", async () => {
    const fromAbs = join(mkdtempSync(join(tmpdir(), "pisquad-diff-from-")), "a.md");
    const toAbs = join(mkdtempSync(join(tmpdir(), "pisquad-diff-to-")), "b.md");
    const newContent = "new line one\nnew line two\n";
    writeFileSync(fromAbs, "old line one\nold line two\n", "utf-8");
    writeFileSync(toAbs, newContent, "utf-8");

    const result = await defaultRenderUnifiedDiff("docs/example.md", fromAbs, toAbs, {
      which: () => null,
      execCapture: async () => {
        throw new Error("execCapture must not be called when diff is missing");
      },
    });
    assert.equal(result, newContent, "fallback returns the new file's content");
  });

  it("uses diff CLI when available and returns its stdout", async () => {
    const fromAbs = join(mkdtempSync(join(tmpdir(), "pisquad-diff-from2-")), "a.md");
    const toAbs = join(mkdtempSync(join(tmpdir(), "pisquad-diff-to2-")), "b.md");
    writeFileSync(fromAbs, "old\n", "utf-8");
    writeFileSync(toAbs, "new\n", "utf-8");

    const fakeDiffOutput = "--- a\n+++ b\n-old\n+new";
    const result = await defaultRenderUnifiedDiff("docs/example.md", fromAbs, toAbs, {
      which: () => "/usr/bin/diff",
      execCapture: async () => ({ stdout: fakeDiffOutput, stderr: "", exitCode: 1 }),
    });
    assert.equal(result, fakeDiffOutput);
  });

  it("returns empty string when diff says files are identical", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pisquad-diff-same-"));
    const a = join(tmp, "a.md");
    const b = join(tmp, "b.md");
    const content = "same content\n";
    writeFileSync(a, content, "utf-8");
    writeFileSync(b, content, "utf-8");
    const result = await defaultRenderUnifiedDiff("same.md", a, b, {
      which: () => "/usr/bin/diff",
      execCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    assert.equal(result, "", "identical files → empty stdout");
  });
});

/**
 * `defaultRenderUnifiedDiffForEntry` is the kind-aware adapter wired into
 * `buildDefaultDecisionDeps`. It receives only `relPath` + `kind` (the
 * signatures the decision layer can safely pass without breaking the pure-
 * coordination contract) and resolves absolute paths itself. These tests
 * exercise every branch and the missing-file warning path.
 */
describe("defaultRenderUnifiedDiffForEntry", () => {
  // Helper: write a file under `root/relPath`, creating parent dirs as needed.
  function writeUnder(root: string, relPath: string, content: string): void {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  it("modified: uses diff CLI between <target>/<relPath> and <assetsRoot>/<relPath>", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-diffentry-tgt-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-diffentry-ast-"));
    const relPath = "docs/example.md";
    writeUnder(target, relPath, "old\n");
    writeUnder(assetsRoot, relPath, "new\n");

    const fakeStdout = "--- a\n+++ b\n-old\n+new";
    const calls: string[][] = [];
    const result = await defaultRenderUnifiedDiffForEntry(relPath, "modified", {
      target,
      assetsRoot,
      which: () => "/usr/bin/diff",
      execCapture: async (_cmd, args) => {
        calls.push(args);
        return { stdout: fakeStdout, stderr: "", exitCode: 1 };
      },
    });
    assert.equal(result, fakeStdout);
    assert.deepEqual(calls[0], ["-u", join(target, relPath), join(assetsRoot, relPath)]);
  });

  it("added: returns new file content even without the diff CLI", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-diffentry-tgt2-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-diffentry-ast2-"));
    const relPath = "docs/brand-new.md";
    const newContent = "completely fresh file content\n";
    writeUnder(assetsRoot, relPath, newContent);

    const result = await defaultRenderUnifiedDiffForEntry(relPath, "added", {
      target,
      assetsRoot,
      which: () => null,
      // execCapture must NOT be invoked when kind !== "modified".
      execCapture: async () => {
        throw new Error("execCapture must not be called for added entries");
      },
    });
    assert.equal(result, newContent, "added entries return the new file content");
  });

  it("added: missing assets file → logs warn, returns empty string", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-diffentry-tgt3-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-diffentry-ast3-"));
    // Don't write the assets file.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = await defaultRenderUnifiedDiffForEntry(
        "docs/missing.md",
        "added",
        {
          target,
          assetsRoot,
          which: () => null,
          execCapture: async () => {
            throw new Error("must not run");
          },
        },
      );
      assert.equal(result, "", "missing file → empty preview");
      assert.equal(
        warnings.some((w) => w.includes("skipping preview")),
        true,
        "warn logged so the user knows the diff was skipped",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("removed: shows current content when file still exists on disk", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-diffentry-tgt4-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-diffentry-ast4-"));
    const relPath = "docs/legacy.md";
    const oldContent = "stale user content\n";
    writeUnder(target, relPath, oldContent);

    const result = await defaultRenderUnifiedDiffForEntry(relPath, "removed", {
      target,
      assetsRoot,
      which: () => null,
      execCapture: async () => {
        throw new Error("must not run for removed entries");
      },
    });
    assert.equal(result, oldContent, "removed entries return the current content");
  });

  it("removed: missing target file → logs informational note, returns empty string", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-diffentry-tgt5-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-diffentry-ast5-"));
    const infos: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      infos.push(args.map(String).join(" "));
    };
    try {
      const result = await defaultRenderUnifiedDiffForEntry(
        "docs/ghost.md",
        "removed",
        {
          target,
          assetsRoot,
          which: () => null,
          execCapture: async () => {
            throw new Error("must not run for removed entries");
          },
        },
      );
      assert.equal(result, "", "missing file → empty preview");
      assert.equal(
        infos.some((line) => line.includes("no longer exists on disk")),
        true,
        "user sees a clear note when the file is already gone",
      );
    } finally {
      console.log = originalLog;
    }
  });
});