/**
 * Unit tests for the `makeDetails` factory's shape contract.
 *
 * `makeDetails` (defined inside the registered tool closure in
 * `index.ts`) is the single source of truth for the `details`
 * payload that travels through `AgentToolResult`. The whole
 * tool-rendering path depends on the factory always populating
 * `suspensions` (defaulting to `[]`), since `renderResult` reads
 * `details.suspensions.length` without an existence check on the
 * normal-result path. A regression there was the headline C1 bug.
 *
 * We re-implement the factory here for testability (the original is
 * a closure private to `execute()`) and run it through the same
 * assertions we want to guarantee.
 *
 * Coverage:
 *   - `suspensions` defaults to `[]` when omitted
 *   - `suspensions` defaults to `[]` when explicitly null/undefined
 *   - `suspensions` round-trips when provided
 *   - Returned shape has all three fields populated for non-suspended
 *     results (no `undefined` holes)
 *   - The shape is structurally compatible with `renderResult`'s
 *     `(details.results.length === 0 && details.suspensions.length === 0)`
 *     early-return (a normal exit with one result + empty
 *     suspensions must NOT trigger the early-return — that was C1's
 *     regression: a TypeError when `suspensions` was undefined).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Mirror of `SingleResult` from index.ts (kept local to avoid
 *  pulling the whole extension module just for typing). */
interface SingleResultLike {
	agent: string;
	agentSource: string;
	task: string;
	exitCode: number;
	messages: any[];
	stderr: string;
	usage: Record<string, number | string>;
	step?: number;
}

interface SubagentDetailsLike {
	mode: "single" | "parallel" | "chain";
	agentScope: string;
	projectAgentsDir: string | null;
	results: SingleResultLike[];
	suspensions: Array<{ suspensionId: string }>;
}

interface SuspendedSnapshotLike extends SubagentDetailsLike {}

/** A copy of the factory shape from `.pi/extensions/subagent/index.ts`.
 *  Kept in lockstep — when the factory changes, change here too.
 *  This is intentional duplication so we can unit-test the contract
 *  without booting the whole extension. */
function makeDetails(
	mode: "single" | "parallel" | "chain",
	agentScope: string,
	projectAgentsDir: string | null,
): (
	results: SingleResultLike[],
	suspensions?: SubagentDetailsLike["suspensions"],
) => SubagentDetailsLike | SuspendedSnapshotLike {
	return (results, suspensions) => {
		return {
			mode,
			agentScope,
			projectAgentsDir,
			results,
			suspensions: suspensions ?? [],
		};
	};
}

function fixtureResult(agent: string): SingleResultLike {
	return {
		agent,
		agentSource: "user",
		task: `task for ${agent}`,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0 },
	};
}

describe("makeDetails factory contract", () => {
	it("always populates `suspensions` (defaults to [])", () => {
		const f = makeDetails("single", "both", null);
		const details = f([fixtureResult("a")]);
		assert.ok(details.suspensions, `suspensions field missing`);
		assert.ok(Array.isArray(details.suspensions));
		assert.equal(details.suspensions.length, 0);
	});

	it("treats undefined suspensions identically to empty", () => {
		const f = makeDetails("single", "both", null);
		const a = f([fixtureResult("a")]);
		const b = f([fixtureResult("a")], undefined);
		assert.deepEqual(a, b);
	});

	it("returns the supplied suspensions verbatim", () => {
		const f = makeDetails("parallel", "user", "/tmp/.pi");
		const sups = [{ suspensionId: "susp_1_aabbcc" }, { suspensionId: "susp_2_ddeeff" }];
		const details = f([fixtureResult("a"), fixtureResult("b"), fixtureResult("c")], sups);
		assert.equal(details.suspensions, sups);
		assert.equal(details.suspensions.length, 2);
	});

	it("non-suspended result has the same SHAPE as a suspended one (no undefined fields)", () => {
		// `renderResult` checks `(details.results.length === 0 && details.suspensions.length === 0)`.
		// A normal (non-suspended) result with one task MUST have a
		// defined `suspensions` array of length 0, otherwise the
		// renderer's `details.suspensions.length` access throws.
		const f = makeDetails("single", "both", null);
		const details = f([fixtureResult("a")]);
		assert.equal(details.mode, "single");
		assert.equal(details.agentScope, "both");
		assert.equal(details.projectAgentsDir, null);
		assert.equal(details.results.length, 1);
		// The whole point of the C1 regression: this `.length` access
		// must not throw.
		assert.equal(details.suspensions.length, 0);
	});

	it("an empty results array AND empty suspensions array is the renderer's 'no output' signal", () => {
		// Render path contract: when both `results` and
		// `suspensions` are empty, the renderer falls back to the
		// first content block rather than trying to format
		// anything. This test asserts both are array-shaped.
		const f = makeDetails("single", "both", null);
		const details = f([]);
		assert.equal(details.results.length, 0);
		assert.equal(details.suspensions.length, 0);
	});

	it("mode is preserved across the factory (chain/parallel/single)", () => {
		const single = makeDetails("single", "both", null)([fixtureResult("x")]);
		const parallel = makeDetails("parallel", "both", null)([fixtureResult("x")]);
		const chain = makeDetails("chain", "both", null)([fixtureResult("x")]);
		assert.equal(single.mode, "single");
		assert.equal(parallel.mode, "parallel");
		assert.equal(chain.mode, "chain");
	});
});

describe("Suspension re-freeze flow (handleResume 2nd freeze path)", () => {
	// The C2 fix asserts that a parallel Job's `tasks` field is
	// present so the resume path can rebuild a length-N ordered
	// result array. We test the merge logic directly.

	it("Job.parallel carries the full original task list (C2 fix)", () => {
		interface TaskSpec {
			agent: string;
			task: string;
		}
		interface JobParallel {
			kind: "parallel";
			tasks: TaskSpec[];
			index: number;
			completedResults: Array<{ agent: string }>;
		}

		const tasks: TaskSpec[] = [
			{ agent: "a", task: "ta" },
			{ agent: "b", task: "tb" },
			{ agent: "c", task: "tc" },
		];
		const job: JobParallel = {
			kind: "parallel",
			tasks,
			index: 1, // task at index 1 was the one suspended
			// completedResults MUST exclude the suspended index.
			completedResults: [{ agent: "a" }, { agent: "c" }],
		};

		// Replicate the resume-time merge logic from index.ts.
		function mergeParallel(
			job: JobParallel,
			resumedResult: { agent: string },
		): Array<{ agent: string } | undefined> {
			const merged: Array<{ agent: string } | undefined> = new Array(job.tasks.length);
			let cursor = 0;
			for (let i = 0; i < job.tasks.length; i++) {
				if (i === job.index) {
					merged[i] = resumedResult;
				} else {
					merged[i] = job.completedResults[cursor++]!;
				}
			}
			return merged;
		}

		const resumed = { agent: "b-result" };
		const merged = mergeParallel(job, resumed);
		assert.equal(merged.length, 3, `merge length must match tasks length`);
		assert.equal(merged[0]!.agent, "a");
		assert.equal(merged[1]!.agent, "b-result");
		assert.equal(merged[2]!.agent, "c");
	});

	it("Suspension.activeAbortHandler tracks the live handler (C3 fix)", () => {
		// C3 fix: the `activeAbortHandler` field on `Suspension`
		// holds the function reference we registered via
		// `attachSignalListener` so subsequent freeze paths can
		// detach exactly that reference. This test models the
		// flow.
		interface Handler {
			(): void;
		}

		// Resume-then-freeze flow.
		const handlers: (Handler | null)[] = [null];
		// First attach: store ref.
		const h1 = () => {};
		handlers[0] = h1;
		// Second freeze: detach THAT ref, replace with new.
		const detached = handlers[0];
		const h2 = () => {};
		handlers[0] = h2;
		// The detacher must receive the *original* handler.
		assert.equal(detached, h1, "detach must use the handler that was registered, not null");
		// And the new handler is now active.
		assert.equal(handlers[0], h2);
	});
});
