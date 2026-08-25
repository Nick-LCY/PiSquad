import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  resolveUpgradeActions,
  type DecisionDeps,
  type DecisionInput,
} from "../../src/upgrade/decision.js";
import type { DiffPlan, PkgInclude } from "../../src/lib/diff.js";
import { EXTENSION_DIRS } from "../../src/lib/plugins/core.js";

/**
 * Helper: compute a stable sha256 hex from a string (mirrors the default
 * `sha256Content` implementation but kept inline so tests don't have to
 * import from `decision.ts`).
 */
function sha256Content(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Minimal deps that record calls and return scripted answers. */
interface Spy {
  deps: DecisionDeps;
  promptStrategyCalls: number;
  promptFileDecisionCalls: number;
  openEditorCalls: number;
  renderUnifiedDiffCalls: number;
}

function makeSpy(overrides: Partial<DecisionDeps> = {}): Spy {
  const spy: Spy = {
    deps: {
      promptStrategy: async () => {
        spy.promptStrategyCalls += 1;
        return "per-file";
      },
      promptFileDecision: async () => {
        spy.promptFileDecisionCalls += 1;
        return "keep";
      },
      openEditor: async () => {
        spy.openEditorCalls += 1;
        return "edited";
      },
      renderUnifiedDiff: async () => {
        spy.renderUnifiedDiffCalls += 1;
        return "";
      },
      sha256Content,
      ...overrides,
    },
    promptStrategyCalls: 0,
    promptFileDecisionCalls: 0,
    openEditorCalls: 0,
    renderUnifiedDiffCalls: 0,
  };
  // Wrap the original functions so call counts are recorded even when the
  // caller passes overrides (we want consistent accounting).
  const userPrompt = overrides.promptStrategy;
  const userFile = overrides.promptFileDecision;
  const userEditor = overrides.openEditor;
  const userDiff = overrides.renderUnifiedDiff;
  spy.deps.promptStrategy = async () => {
    spy.promptStrategyCalls += 1;
    return userPrompt ? userPrompt() : "per-file";
  };
  spy.deps.promptFileDecision = async (entry, remaining, kind) => {
    spy.promptFileDecisionCalls += 1;
    return userFile ? userFile(entry, remaining, kind) : "keep";
  };
  spy.deps.openEditor = async (relPath, current, incoming) => {
    spy.openEditorCalls += 1;
    return userEditor ? userEditor(relPath, current, incoming) : "edited";
  };
  spy.deps.renderUnifiedDiff = async (relPath, kind) => {
    spy.renderUnifiedDiffCalls += 1;
    return userDiff ? userDiff(relPath, kind) : "";
  };
  spy.deps.sha256Content = overrides.sha256Content ?? sha256Content;
  return spy;
}

/** Standard fixture: three interactive includes + the core extension set. */
const INTERACTIVE_INCLUDES: PkgInclude[] = [
  { pkgSubPath: "docs", targetSubPath: "docs", interactive: true },
  { pkgSubPath: ".pi/agents", targetSubPath: ".pi/agents", interactive: true },
  { pkgSubPath: ".pi/skills", targetSubPath: ".pi/skills", interactive: true },
];
/**
 * Derived from `EXTENSION_DIRS` (single source of truth in
 * `src/lib/plugins/core.ts`) so a new core extension added there — e.g.
 * `bash-guard` in 0.3.0 — automatically lands in this fixture. Hardcoding
 * a parallel list here was the 0.3.1 bug's root cause: the production
 * `upgrade.ts` includes list and this fixture drifted apart, and the unit
 * tests lost their red/green signal. See ADR [[architecture/decisions/0004-subagent-suspension-arbitration.md]]
 * and the L4 contract in `docs/conventions/release-verification.md`.
 */
const MANAGED_INCLUDES: PkgInclude[] = Array.from(EXTENSION_DIRS).map((sub) => ({
  pkgSubPath: `.pi/${sub}`,
  targetSubPath: `.pi/${sub}`,
}));

function planFixture(): DiffPlan {
  return {
    modified: [
      { relPath: "docs/README.md", fromHash: "h-old-1", toHash: "h-new-1" },
      { relPath: "docs/sub.md", fromHash: "h-old-2", toHash: "h-new-2" },
      { relPath: ".pi/agents/worker.md", fromHash: "h-old-3", toHash: "h-new-3" },
    ],
    added: [
      { relPath: "docs/new.md", toHash: "h-new-4" },
      { relPath: ".pi/skills/project-docs/SKILL.md", toHash: "h-new-5" },
    ],
    removed: [{ relPath: "docs/old.md", fromHash: "h-old-r1" }],
    unchanged: [],
  };
}

function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    plan: planFixture(),
    includes: [...INTERACTIVE_INCLUDES, ...MANAGED_INCLUDES],
    target: "/tmp/fake-target",
    prune: false,
    interactive: true,
    interactiveSetByUser: true,
    isInteractiveEnv: true,
    yes: false,
    ...overrides,
  };
}

describe("resolveUpgradeActions", () => {
  it("all-adopt: backups 3 modified, adopts 5 (3+2), keeps 1 removed", async () => {
    const spy = makeSpy({
      promptStrategy: async () => "all-adopt",
    });
    const result = await resolveUpgradeActions(baseInput(), spy.deps);
    // Interactive: 3 modified + 2 added adopt (3 modified also backup).
    // Removed interactive: 1 file kept (since prune=false).
    assert.equal(result.adopt.size, 5, "adopt = 3 modified + 2 added");
    assert.equal(result.keep.size, 1, "keep = 1 removed (no prune)");
    assert.equal(result.remove.size, 0);
    assert.equal(result.backup.size, 3, "backup = 3 modified (interactive)");
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 1);
    assert.equal(spy.promptFileDecisionCalls, 0, "no per-file prompts");
    assert.equal(spy.openEditorCalls, 0, "no editor opened");
  });

  it("all-keep: 0 adopt, all 6 in keep, 0 backup", async () => {
    const spy = makeSpy({
      promptStrategy: async () => "all-keep",
    });
    const result = await resolveUpgradeActions(baseInput(), spy.deps);
    assert.equal(result.adopt.size, 0);
    assert.equal(result.keep.size, 6, "keep = 3 modified + 2 added + 1 removed");
    assert.equal(result.remove.size, 0);
    assert.equal(result.backup.size, 0);
    assert.equal(result.mode, "all-keep");
    assert.equal(spy.promptStrategyCalls, 1);
    assert.equal(spy.promptFileDecisionCalls, 0);
  });

  it("per-file: every interactive decision = keep, all adopt+backup paths still go through managed-only", async () => {
    // Plan with only managed entries — no interactive at all.
    const managedOnlyPlan: DiffPlan = {
      modified: [
        { relPath: ".pi/extensions/subagent/index.ts", fromHash: "h-m1", toHash: "h-n1" },
      ],
      added: [],
      removed: [],
      unchanged: [],
    };
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
    });
    const result = await resolveUpgradeActions(
      baseInput({ plan: managedOnlyPlan }),
      spy.deps,
    );
    // Only managed entries — no prompt needed (managed is auto-resolve).
    assert.equal(result.adopt.size, 1);
    assert.equal(result.backup.size, 1);
    assert.equal(spy.promptStrategyCalls, 0, "no strategy prompt when there are no interactive entries");
    assert.equal(spy.promptFileDecisionCalls, 0);
  });

  it("per-file: when user picks keep for every interactive file, only modified/added go into backup if they were 'adopt'", async () => {
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => "keep",
    });
    const result = await resolveUpgradeActions(baseInput(), spy.deps);
    // Interactive counts: 3 modified + 2 added + 1 removed = 6 in total.
    // Default baseInput has prune=false, so the W2 fix auto-keeps the
    // removed file without firing promptFileDecision — only 5 prompts
    // run, but all 6 files end up in the keep set.
    assert.equal(result.adopt.size, 0, "no adopt when every interactive file is kept");
    assert.equal(result.keep.size, 6, "keep = 3 modified + 2 added + 1 removed (auto)");
    assert.equal(result.backup.size, 0, "no backup when nothing is overwritten");
    // promptFileDecision is invoked for each of the 5 promptable interactive
    // entries (managed entries never reach the per-file loop, and prune=false
    // suppresses the removed prompt per the W2 fix).
    assert.equal(spy.promptFileDecisionCalls, 5);
    assert.equal(spy.openEditorCalls, 0, "no edits");
  });

  it("per-file mid-stream __adopt-all: remaining interactive files collapse to adopt", async () => {
    const answers = [
      "keep",
      "__adopt-all",
    ] as const;
    let i = 0;
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => {
        const v = answers[i++] ?? "keep";
        return v as "keep" | "__adopt-all";
      },
    });
    const result = await resolveUpgradeActions(baseInput(), spy.deps);
    // First file: keep. Second file: __adopt-all → triggers batch.
    // Remaining 5 interactive files (4 left + current) all adopt.
    // Files:
    //   modified[0] = docs/README.md (interactive) → keep
    //   modified[1] = docs/sub.md (interactive) → adopt
    //   modified[2] = .pi/agents/worker.md (interactive) → adopt
    //   added[0]    = docs/new.md (interactive) → adopt
    //   added[1]    = .pi/skills/.../SKILL.md (interactive) → adopt
    //   removed[0]  = docs/old.md (interactive, prune=false) → adopt-batch... but removed
    //                  batch treats them as "keep" by default (no --prune).
    assert.equal(spy.promptFileDecisionCalls, 2, "broke out of the loop at the batch shortcut");
    // Interactive batch adopt on a `removed` file without prune = keep.
    // 4 adopted (2 modified + 2 added), 2 kept (1 modified + 1 removed).
    assert.equal(result.adopt.size, 4);
    assert.equal(result.keep.size, 2);
    assert.equal(result.backup.size, 2, "backup = 2 modified (adopted)");
  });

  it("per-file edit: openEditor called once, editResults recorded, backup includes that file", async () => {
    const editedText = "manually merged content";
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      // First modified is docs/README.md → pick "edit".
      promptFileDecision: async (_entry, remaining) => {
        if (remaining === 5) return "edit";
        return "keep";
      },
      openEditor: async () => editedText,
    });
    const result = await resolveUpgradeActions(baseInput(), spy.deps);
    assert.equal(spy.openEditorCalls, 1);
    assert.equal(result.editResults.length, 1);
    const first = result.editResults[0]!;
    assert.equal(first.relPath, "docs/README.md");
    assert.equal(first.content, editedText);
    assert.equal(first.matchesTheirs, false, "matchesTheirs false because toHash is fake");
    assert.ok(result.backup.has("docs/README.md"));
    // Note: the file is NOT in `adopt` because the copy filter will skip it
    // (the upgrade command's filter checks editResults).
    assert.equal(result.adopt.has("docs/README.md"), false);
  });

  it("non-interactive environment: no prompts at all, falls back to all-adopt", async () => {
    const spy = makeSpy();
    const result = await resolveUpgradeActions(
      baseInput({ isInteractiveEnv: false }),
      spy.deps,
    );
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 0);
    assert.equal(spy.promptFileDecisionCalls, 0);
    assert.equal(spy.openEditorCalls, 0);
    // Interactive modified → adopt+backup (3), interactive added → adopt (2),
    // interactive removed (no prune) → keep (1).
    assert.equal(result.adopt.size, 5);
    assert.equal(result.keep.size, 1);
    assert.equal(result.backup.size, 3);
  });

  it("--no-interactive: explicit opt-out still triggers all-adopt default without prompts", async () => {
    const spy = makeSpy();
    const result = await resolveUpgradeActions(
      baseInput({ interactive: false, interactiveSetByUser: true }),
      spy.deps,
    );
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 0);
    assert.equal(spy.promptFileDecisionCalls, 0);
    assert.equal(result.adopt.size, 5);
  });

  it("--yes: yes flag suppresses prompts even on a tty", async () => {
    const spy = makeSpy();
    const result = await resolveUpgradeActions(
      baseInput({ yes: true }),
      spy.deps,
    );
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 0);
  });

  it("empty plan: returns empty ResolvedPlan without calling prompts", async () => {
    const spy = makeSpy();
    const emptyPlan: DiffPlan = { modified: [], added: [], removed: [], unchanged: [] };
    const result = await resolveUpgradeActions(
      baseInput({ plan: emptyPlan }),
      spy.deps,
    );
    assert.equal(result.adopt.size, 0);
    assert.equal(result.keep.size, 0);
    assert.equal(result.remove.size, 0);
    assert.equal(result.backup.size, 0);
    assert.equal(result.editResults.length, 0);
    assert.equal(spy.promptStrategyCalls, 0);
  });

  it("managed entries (interactive=false) are auto-resolved regardless of prompt deps", async () => {
    // Even if prompt deps would error (we throw), managed entries are
    // resolved before any prompt is fired.
    const managedPlan: DiffPlan = {
      modified: [
        { relPath: ".pi/extensions/subagent/a.ts", fromHash: "h-m1", toHash: "h-n1" },
        { relPath: ".pi/extensions/wikilink-lint/b.ts", fromHash: "h-m2", toHash: "h-n2" },
      ],
      added: [],
      removed: [],
      unchanged: [],
    };
    const spy = makeSpy();
    const result = await resolveUpgradeActions(
      baseInput({ plan: managedPlan }),
      spy.deps,
    );
    assert.equal(result.adopt.size, 2);
    assert.equal(result.backup.size, 2, "both managed modified backed up");
    // No interactive entries → no strategy prompt.
    assert.equal(spy.promptStrategyCalls, 0);
  });

  it("prune=true: removed entries are presented for prompt decision and end up in remove set when adopted", async () => {
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      // All kept — but specifically test that removed is asked.
      promptFileDecision: async () => "keep",
    });
    const result = await resolveUpgradeActions(
      baseInput({ prune: true }),
      spy.deps,
    );
    // Interactive removed (docs/old.md, no prune in plan but yes prune flag) → keep.
    assert.ok(result.keep.has("docs/old.md"));
    assert.equal(result.remove.size, 0);
    // Verify that promptFileDecision was called for the removed file.
    const removedPrompted = spy.promptFileDecisionCalls === 6; // 3 mod + 2 add + 1 rem
    assert.ok(removedPrompted, "removed file was prompted");
  });

  it("prune=true: removed adopted → goes into remove and backup", async () => {
    const answers: Array<"adopt" | "keep" | "edit" | "__adopt-all" | "__keep-all"> = ["adopt"];
    let i = 0;
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => {
        return answers[i++] ?? "adopt";
      },
    });
    const result = await resolveUpgradeActions(
      baseInput({ prune: true }),
      spy.deps,
    );
    // First entry (docs/README.md, modified) → adopt+backup.
    // Subsequent batch adopt fills the rest, including removed which becomes remove+backup.
    assert.ok(result.remove.has("docs/old.md"));
    assert.ok(result.backup.has("docs/old.md"));
  });

  it("edit: empty editor result → treated as keep, no edit result, no backup", async () => {
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async (_entry, remaining) => {
        if (remaining === 5) return "edit";
        return "keep";
      },
      openEditor: async () => "",
    });
    const result = await resolveUpgradeActions(baseInput(), spy.deps);
    assert.equal(result.editResults.length, 0);
    assert.ok(result.keep.has("docs/README.md"));
    assert.equal(result.backup.has("docs/README.md"), false);
    assert.equal(result.adopt.has("docs/README.md"), false);
  });

  it("edit: matchesTheirs=true when user saves content that hashes to toHash", async () => {
    const plan = planFixture();
    const targetContent = "whatever the user already had"; // arbitrary
    const newContent = "the new version of the file"; // arbitrary
    const newHash = sha256Content(newContent);
    // Mutate the plan so docs/README.md's toHash matches sha256 of newContent.
    const modifiedIdx = plan.modified.findIndex((m: { relPath: string }) => m.relPath === "docs/README.md")!;
    plan.modified[modifiedIdx] = { ...plan.modified[modifiedIdx]!, toHash: newHash };
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async (_entry, remaining) => {
        if (remaining === 5) return "edit";
        return "keep";
      },
      openEditor: async () => newContent,
    });
    const result = await resolveUpgradeActions(baseInput({ plan }), spy.deps);
    assert.equal(result.editResults.length, 1);
    assert.equal(result.editResults[0]!.matchesTheirs, true);
    // ignore targetContent / unused-variable lint
    void targetContent;
  });

  it("per-file + prune=false: removed entries do not trigger promptFileDecision (auto-keep)", async () => {
    // Regression for the W2 review finding: when the user picked "Decide
    // per file" but prune is off, asking about a `removed` file would only
    // produce confusing no-ops (we can't delete without --prune). The
    // decision layer must auto-apply keep and skip the prompt entirely.
    const seenKinds: string[] = [];
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async (_entry, _remaining, kind) => {
        seenKinds.push(kind);
        if (kind === "removed") {
          throw new Error(
            "promptFileDecision must not be called for `removed` entries when prune is false",
          );
        }
        return "keep";
      },
    });
    const result = await resolveUpgradeActions(baseInput({ prune: false }), spy.deps);
    // The single interactive `removed` file from the fixture was auto-kept.
    assert.ok(result.keep.has("docs/old.md"), "removed file auto-kept without prompt");
    assert.equal(result.remove.has("docs/old.md"), false, "not added to remove set");
    // No prompts fired for the removed entry. The other 5 interactive
    // entries (3 modified + 2 added) are also queried — they all fall
    // through the per-file loop, so the only prompt we expect is for
    // those 5. Verify removed is NOT among them.
    const queriedKinds = spy.promptFileDecisionCalls;
    assert.equal(queriedKinds, 5, "only 5 interactive entries are prompted (removed skipped)");
    assert.equal(seenKinds.includes("removed"), false, "no removed prompts were fired");
    // entries map records the auto-keep decision for documentation/summary.
    assert.equal(result.entries.get("docs/old.md"), "keep");
  });

  it("per-file: renderUnifiedDiff fires once before each promptFileDecision (modified/added)", async () => {
    // "Show diff before asking" wiring. Records an ordered event log so
    // we can assert that each prompt is preceded by a render for the same
    // relPath, and that auto-kept `removed` entries (no --prune) skip
    // both the render and the prompt.
    const events: string[] = [];
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async (entry) => {
        events.push(`prompt:${entry.relPath}:${entry.kind}`);
        return "keep";
      },
      renderUnifiedDiff: async (relPath, kind) => {
        events.push(`diff:${relPath}:${kind}`);
        return "";
      },
    });
    await resolveUpgradeActions(baseInput(), spy.deps);

    const renders = events.filter((e) => e.startsWith("diff:"));
    const prompts = events.filter((e) => e.startsWith("prompt:"));
    // 3 modified + 2 added in the fixture = 5 entries that go through
    // the prompt. The single `removed` file is auto-kept (no --prune)
    // and contributes neither a render nor a prompt.
    assert.equal(spy.renderUnifiedDiffCalls, 5, "5 renders fired");
    assert.equal(spy.promptFileDecisionCalls, 5, "5 prompts fired");
    assert.equal(spy.renderUnifiedDiffCalls, spy.promptFileDecisionCalls, "1:1 render/prompt pairing");
    assert.equal(renders.length, 5);
    assert.equal(prompts.length, 5);
    // Ordering: every prompt must be immediately preceded by a render
    // targeting the same relPath + kind.
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (!ev.startsWith("prompt:")) continue;
      const prev = events[i - 1];
      assert.ok(prev !== undefined, `prompt at index ${i} should have a preceding render`);
      assert.ok(
        prev.startsWith("diff:"),
        `expected a render immediately before ${ev} but found ${prev}`,
      );
      const promptTail = ev.slice("prompt:".length);
      const diffTail = prev.slice("diff:".length);
      assert.equal(
        diffTail,
        promptTail,
        `render and prompt must reference the same relPath + kind (got ${prev} vs ${ev})`,
      );
    }
  });

  it("per-file: renderUnifiedDiff also fires for removed entries when --prune is set", async () => {
    // When --prune is on, `removed` entries ARE prompted — so their
    // diff preview must also fire (the user is being asked to delete
    // the file and should see what would be removed first).
    const rendered: Array<{ relPath: string; kind: string }> = [];
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async (entry) => {
        // Adopt the modified files, keep the removed ones — we only
        // care that the render happened, not the outcome.
        return entry.kind === "removed" ? "keep" : "adopt";
      },
      renderUnifiedDiff: async (relPath, kind) => {
        rendered.push({ relPath, kind });
        return "";
      },
    });
    await resolveUpgradeActions(baseInput({ prune: true }), spy.deps);
    // 3 modified + 2 added + 1 removed = 6 prompted → 6 renders.
    assert.equal(spy.renderUnifiedDiffCalls, 6, "render fires for every prompted entry including removed");
    assert.ok(
      rendered.some((r) => r.relPath === "docs/old.md" && r.kind === "removed"),
      "render fired for the removed entry under prune=true",
    );
  });

  it("per-file: renderUnifiedDiff is not called when the dep is omitted", async () => {
    // Sanity check: builds a deps bag WITHOUT renderUnifiedDiff to
    // verify the decision layer guards correctly. No throw, no implicit
    // invocation of the default adapter — the per-file flow simply
    // skips the preview step.
    const deps: DecisionDeps = {
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => "keep",
      openEditor: async () => "edited",
      sha256Content,
    };
    const result = await resolveUpgradeActions(baseInput(), deps);
    // Entries still resolved correctly.
    assert.equal(result.entries.size, 6, "all 6 interactive entries recorded");
    assert.equal(result.adopt.size, 0, "everyone picked keep");
  });

  it("per-file: renderUnifiedDiff throwing falls back to prompt with a warn", async () => {
    // Requirement #5: diff render failures MUST NOT block the prompt.
    // The decision layer catches the rejection, logs a warn, and
    // proceeds. The user still gets to pick per-file.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const spy = makeSpy({
        promptStrategy: async () => "per-file",
        promptFileDecision: async () => "keep",
        renderUnifiedDiff: async () => {
          throw new Error("synthetic diff failure");
        },
      });
      const result = await resolveUpgradeActions(baseInput(), spy.deps);
      assert.equal(result.entries.size, 6, "all entries still resolved despite render failure");
      assert.equal(spy.promptFileDecisionCalls, 5, "prompts still fired");
      // The synthetic failure must surface as a warn so the user knows
      // the diff preview was skipped (not silently consumed).
      const sawWarn = warnings.some((w) => w.includes("skipping preview"));
      assert.equal(sawWarn, true, `expected a "skipping preview" warning; got: ${warnings.join(" | ")}`);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("no flag + tty: implicit interactive mode fires per-file prompts (ADR-0003 §5)", async () => {
    // Caller (upgrade.ts:261) narrows `options.interactive === true` so
    // an unpassed flag arrives here as `interactive: false`. Combined
    // with `interactiveSetByUser: false` and `isInteractiveEnv: true`,
    // the decision layer MUST still enter the interactive path.
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => "keep",
    });
    const result = await resolveUpgradeActions(
      baseInput({
        interactive: false,
        interactiveSetByUser: false,
        isInteractiveEnv: true,
      }),
      spy.deps,
    );
    assert.equal(result.mode, "per-file", "tty without flag must trigger interactive flow");
    assert.equal(spy.promptStrategyCalls, 1, "strategy prompt fired");
    // 3 modified + 2 added prompted (prune=false, so removed auto-keeps).
    assert.equal(spy.promptFileDecisionCalls, 5);
    assert.equal(result.adopt.size, 0);
    assert.equal(result.keep.size, 6);
  });

  it("--no-interactive + tty: explicit opt-out still falls back to all-adopt", async () => {
    // Mirrors the existing "explicit opt-out" test but makes the
    // contrast with the no-flag case explicit so future readers don't
    // confuse the two.
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => "keep",
    });
    const result = await resolveUpgradeActions(
      baseInput({
        interactive: false,
        interactiveSetByUser: true,
        isInteractiveEnv: true,
      }),
      spy.deps,
    );
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 0, "explicit --no-interactive suppresses strategy prompt");
    assert.equal(spy.promptFileDecisionCalls, 0);
    assert.equal(result.adopt.size, 5);
  });

  it("--interactive without tty: degrades to all-adopt (warning fires upstream)", async () => {
    // upgrade.ts logs the user-facing warn before calling
    // resolveUpgradeActions; the decision layer itself just sees
    // `isInteractiveEnv: false` and must yield batch adopt.
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => "keep",
    });
    const result = await resolveUpgradeActions(
      baseInput({
        interactive: true,
        interactiveSetByUser: true,
        isInteractiveEnv: false,
      }),
      spy.deps,
    );
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 0);
    assert.equal(spy.promptFileDecisionCalls, 0);
    assert.equal(result.adopt.size, 5);
    assert.equal(result.keep.size, 1);
  });

  it("--yes + tty: yes flag wins over interactive intent", async () => {
    const spy = makeSpy({
      promptStrategy: async () => "per-file",
      promptFileDecision: async () => "keep",
    });
    const result = await resolveUpgradeActions(
      baseInput({
        interactive: true,
        interactiveSetByUser: true,
        isInteractiveEnv: true,
        yes: true,
      }),
      spy.deps,
    );
    assert.equal(result.mode, "all-adopt");
    assert.equal(spy.promptStrategyCalls, 0, "--yes must short-circuit before strategy prompt");
    assert.equal(spy.promptFileDecisionCalls, 0);
    assert.equal(result.adopt.size, 5);
  });
});
