import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultOpenEditor } from "../../src/upgrade/decision-defaults.js";

/**
 * Regression tests for `defaultOpenEditor` — the merge-buffer
 * constructor + editor adapter used by the upgrade command's
 * "Edit / merge manually" branch.
 *
 * The function does three things that are worth pinning down:
 *
 *   1. Build a git-merge-style conflict buffer with `<<<<<<<` /
 *      `=======` / `>>>>>>>` markers around the current and incoming
 *      file contents. The markers must always land on their own line,
 *      even when the underlying files are empty or have no trailing
 *      newline.
 *   2. Pick a meaningful `postfix` for the spawned editor so syntax
 *      highlighting is correct — including dotfile / extensionless
 *      edge cases like `.gitignore` and `Makefile` that the previous
 *      `extname() || ".txt"` shortcut got wrong.
 *   3. Validate the edited text so the user can't save a buffer that
 *      still contains conflict markers, and degrade gracefully when
 *      the editor itself errors out (missing binary, Ctrl+C, etc.).
 *
 * `defaultOpenEditor` takes an injectable `editorPrompt` stub so we
 * can drive it without spawning a real editor. The stub captures the
 * full prompt config (message / default / postfix / waitForUserInput
 * / validate) for assertions.
 */

interface CapturedEditorConfig {
  message: string;
  default?: string;
  postfix?: string;
  waitForUserInput?: boolean;
  validate?: (text: string) => boolean | string | Promise<string | boolean>;
}

interface EditorStub {
  fn: (config: CapturedEditorConfig) => Promise<string>;
  calls: CapturedEditorConfig[];
}

/** Build a stub `editorPrompt` that records every call and returns a
 * pre-canned answer. */
function makeEditorStub(answer: string | (() => string)): EditorStub {
  const calls: CapturedEditorConfig[] = [];
  return {
    calls,
    fn: async (config) => {
      calls.push(config);
      return typeof answer === "function" ? answer() : answer;
    },
  };
}

/** Build a stub `editorPrompt` that throws every time it's called. */
function makeThrowingEditorStub(error: Error): EditorStub {
  const calls: CapturedEditorConfig[] = [];
  return {
    calls,
    fn: async (config) => {
      calls.push(config);
      throw error;
    },
  };
}

/** Write a file under `root/relPath`, creating parent dirs as needed. */
function writeUnder(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

/** Strip picocolors ANSI escapes for cleaner equality assertions. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("defaultOpenEditor", () => {
  it("empty current + empty incoming: conflict markers still land on their own lines", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-tgt-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-ast-"));
    const relPath = "docs/empty.md";
    writeUnder(target, relPath, "");
    writeUnder(assetsRoot, relPath, "");

    const stub = makeEditorStub("user resolved to: nothing\n");
    const result = await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    assert.equal(result, "user resolved to: nothing\n");
    assert.equal(stub.calls.length, 1);
    const defaultBuffer = stub.calls[0]!.default ?? "";
    // The buffer must be: marker \n ======= \n marker \n. Both sides are
    // empty so the lines between the markers should collapse to nothing
    // but the markers themselves must each occupy their own line.
    assert.match(defaultBuffer, /^<<<<<<< current \(your version\)\n\n=======\n\n>>>>>>> incoming \(new version\)\n$/);
  });

  it("files without trailing newlines: ensureTrailingNewline adds one so the ======= / >>>>>>> markers stand alone", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-nl-tgt-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-nl-ast-"));
    const relPath = "docs/no-trailing.md";
    // Deliberately write files with NO trailing newline.
    writeUnder(target, relPath, "current line one\ncurrent line two");
    writeUnder(assetsRoot, relPath, "incoming line one\nincoming line two");

    const stub = makeEditorStub("merged\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    const defaultBuffer = stub.calls[0]!.default ?? "";
    // After `ensureTrailingNewline`, both sides end with \n and the
    // ======= / >>>>>>> markers each start on their own line.
    assert.match(defaultBuffer, /<<<<<<< current \(your version\)\ncurrent line one\ncurrent line two\n=======\nincoming line one\nincoming line two\n>>>>>>> incoming \(new version\)\n/);
    // And there must be NO occurrence of "two=======" or "two>>>>>>>"
    // (which would mean a missing newline concatenated the marker onto
    // the last content line).
    assert.equal(
      defaultBuffer.includes("two======="),
      false,
      "======= marker must not be glued onto the previous line",
    );
    assert.equal(
      defaultBuffer.includes("two>>>>>>>"),
      false,
      ">>>>>>> marker must not be glued onto the previous line",
    );
  });

  it("postfix: extensionless file → falls back to .txt", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-txt-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-txt-ast-"));
    const relPath = "Makefile";
    writeUnder(target, relPath, "old makefile\n");
    writeUnder(assetsRoot, relPath, "new makefile\n");

    const stub = makeEditorStub("MERGED\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    assert.equal(stub.calls[0]!.postfix, ".txt");
  });

  it("postfix: dotfile (e.g. .gitignore) → uses the full basename as postfix", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-dot-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-dot-ast-"));
    const relPath = ".gitignore";
    writeUnder(target, relPath, "node_modules\n");
    writeUnder(assetsRoot, relPath, "node_modules\ndist\n");

    const stub = makeEditorStub("merged\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    assert.equal(stub.calls[0]!.postfix, ".gitignore");
  });

  it("postfix: regular extension → uses the extension verbatim", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-ts-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-ts-ast-"));
    const relPath = "src/example.ts";
    writeUnder(target, relPath, "const x = 1;\n");
    writeUnder(assetsRoot, relPath, "const x = 2;\n");

    const stub = makeEditorStub("const x = 3;\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    assert.equal(stub.calls[0]!.postfix, ".ts");
  });

  it("postfix: dotfile with explicit extension (e.g. .eslintrc.json) → uses the extension", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-dot-ext-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-pf-dot-ext-ast-"));
    const relPath = ".eslintrc.json";
    writeUnder(target, relPath, "{}\n");
    writeUnder(assetsRoot, relPath, "{}\n");

    const stub = makeEditorStub("{}\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    // `.eslintrc.json` has a recognised extension → ".json", not the
    // full basename. Confirms the dotfile fallback only fires when
    // `extname` is empty.
    assert.equal(stub.calls[0]!.postfix, ".json");
  });

  it("normal path: editor's returned content is propagated verbatim", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-ok-tgt-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-ok-ast-"));
    const relPath = "docs/example.md";
    writeUnder(target, relPath, "old\n");
    writeUnder(assetsRoot, relPath, "new\n");

    const userContent = "manually resolved content\n";
    const stub = makeEditorStub(userContent);
    const result = await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    assert.equal(result, userContent);
  });

  it("editor exception: returns empty string (treated as 'keep my version' upstream)", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-err-tgt-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-err-ast-"));
    const relPath = "docs/example.md";
    writeUnder(target, relPath, "old\n");
    writeUnder(assetsRoot, relPath, "new\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const stub = makeThrowingEditorStub(new Error("synthetic editor failure"));
      const result = await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

      assert.equal(result, "", "editor exception → empty string fallback");
      const sawWarn = warnings.some((w) =>
        w.includes("editor failed for") && w.includes("synthetic editor failure"),
      );
      assert.equal(
        sawWarn,
        true,
        `expected a warn that surfaces the editor error; got: ${warnings.join(" | ")}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("waitForUserInput is set to false (no extra 'press Enter to confirm' step)", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-wfui-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-wfui-ast-"));
    const relPath = "docs/example.md";
    writeUnder(target, relPath, "old\n");
    writeUnder(assetsRoot, relPath, "new\n");

    const stub = makeEditorStub("merged\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    assert.equal(stub.calls[0]!.waitForUserInput, false);
  });

  it("default buffer contains the git-style conflict markers in the expected format", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-mk-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-mk-ast-"));
    const relPath = "docs/example.md";
    writeUnder(target, relPath, "your line 1\nyour line 2\n");
    writeUnder(assetsRoot, relPath, "their line 1\ntheir line 2\n");

    const stub = makeEditorStub("merged\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    const expected =
      `<<<<<<< current (your version)\n` +
      `your line 1\n` +
      `your line 2\n` +
      `=======\n` +
      `their line 1\n` +
      `their line 2\n` +
      `>>>>>>> incoming (new version)\n`;
    assert.equal(stripAnsi(stub.calls[0]!.default ?? ""), expected);
  });

  it("validate: rejects text that still contains conflict markers", async () => {
    const target = mkdtempSync(join(tmpdir(), "pisquad-editor-val-"));
    const assetsRoot = mkdtempSync(join(tmpdir(), "pisquad-editor-val-ast-"));
    const relPath = "docs/example.md";
    writeUnder(target, relPath, "old\n");
    writeUnder(assetsRoot, relPath, "new\n");

    const stub = makeEditorStub("merged\n");
    await defaultOpenEditor(relPath, target, assetsRoot, stub.fn);

    const validate = stub.calls[0]!.validate;
    assert.ok(validate, "validate function must be passed to the editor prompt");

    // Still has <<<<<<< → reject with the user-facing message.
    const stillHasOpen = validate("<<<<<<< current\nfoo\n");
    assert.notEqual(stillHasOpen, true, "open marker present → must reject");
    assert.equal(
      typeof stillHasOpen,
      "string",
      "rejection should be a human-readable string",
    );
    assert.match(stillHasOpen as string, /Conflict markers are still present/);

    // Still has >>>>>>> → reject too.
    const stillHasClose = validate("foo\n>>>>>>> incoming\n");
    assert.notEqual(stillHasClose, true, "close marker present → must reject");
    assert.match(stillHasClose as string, /Conflict markers are still present/);

    // Resolved text → accept.
    const resolved = validate("merged cleanly\n");
    assert.equal(resolved, true, "marker-free text must validate as true");
  });
});
