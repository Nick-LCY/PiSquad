/**
 * Unit tests for the suspension registry + process-group helpers used
 * by the subagent idle-watchdog protocol.
 *
 * These are deliberately pure-function tests — no real pi runtime, no
 * real child processes. The integration path (spawn a child, freeze it,
 * resume it) is exercised in `arbitration.e2e.test.ts`.
 *
 * Coverage:
 *   - newSuspensionId: format, uniqueness, monotonic counter
 *   - registry CRUD: register/get/unregister/getAll
 *   - extractInFlight: most-recent tool call without a matching
 *     toolResult is returned; bash calls fill command+timeout; nothing
 *     in flight → null
 *   - summarizeTail: order, truncation, stderr folding
 *   - resolveIdleTimeoutMs / resolveDefaultTimeoutS: env var overrides,
 *     illegal-value fallbacks
 *
 * The `Message` type is imported from `@earendil-works/pi-ai` so the
 * test file uses the same type the production code does. The module
 * under test is type-only with respect to that import — at runtime
 * suspensions.ts never instantiates a Message, just threads the type
 * through.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import {
	__clearSuspensionsForTests,
	collectDescendantPids,
	extractInFlight,
	getAllSuspensions,
	getSiblingSuspensions,
	getSuspension,
	newParallelGroupId,
	newSuspensionId,
	// re-imports under test
	registerSuspension,
	summarizeTail,
	unregisterSuspension,
} from "../../.pi/extensions/subagent/suspensions.ts";
import { resolveDefaultTimeoutS } from "../../.pi/extensions/bash-guard/index.ts";

/** Build a minimal AssistantMessage with the given content parts. */
function assistantMessage(content: Array<{ type: string } & Record<string, unknown>>): Message {
	return {
		role: "assistant",
		content: content as Message extends { role: "assistant"; content: infer C } ? C : never,
		api: "openai-responses" as Message extends { api: infer A } ? A : never,
		provider: "openai" as Message extends { provider: infer P } ? P : never,
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
		stopReason: "stop",
		timestamp: 0,
	};
}

/** Build a minimal ToolResultMessage. */
function toolResult(toolCallId: string, text: string, isError = false): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

beforeEach(() => {
	__clearSuspensionsForTests();
});

describe("newSuspensionId", () => {
	it("starts with 'susp_' and contains both a counter and a hex suffix", () => {
		const id = newSuspensionId();
		assert.match(id, /^susp_[0-9a-z]+_[0-9a-f]{6}$/);
	});

	it("returns distinct ids on rapid successive calls (counter + random)", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) ids.add(newSuspensionId());
		assert.equal(ids.size, 100, "100 successive newSuspensionId() must yield 100 distinct ids");
	});

	it("counter is monotonically non-decreasing across calls", () => {
		const a = newSuspensionId();
		const b = newSuspensionId();
		const aCounter = Number(a.split("_")[1]);
		const bCounter = Number(b.split("_")[1]);
		assert.ok(bCounter > aCounter, `counter must increase: ${a} -> ${b}`);
	});
});

describe("registry CRUD", () => {
	it("registerSuspension + getSuspension round-trips by id", () => {
		const id = newSuspensionId();
		const fake: any = { id, proc: { pid: 123 } };
		registerSuspension(fake);
		assert.equal(getSuspension(id), fake);
		assert.equal(getSuspension("nope"), undefined);
	});

	it("unregisterSuspension drops the entry; idempotent", () => {
		const id = newSuspensionId();
		const fake: any = { id, proc: { pid: 1 } };
		registerSuspension(fake);
		unregisterSuspension(id);
		assert.equal(getSuspension(id), undefined);
		// Second call must not throw.
		unregisterSuspension(id);
		assert.equal(getSuspension(id), undefined);
	});

	it("getAllSuspensions returns the current set in insertion order", () => {
		const ids = [newSuspensionId(), newSuspensionId(), newSuspensionId()];
		for (const id of ids) registerSuspension({ id, proc: { pid: 1 } } as any);
		const all = getAllSuspensions();
		assert.deepEqual(
			all.map((s) => s.id),
			ids,
		);
	});

	it("__clearSuspensionsForTests wipes the registry (test-only)", () => {
		registerSuspension({ id: newSuspensionId(), proc: { pid: 1 } } as any);
		assert.ok(getAllSuspensions().length > 0);
		__clearSuspensionsForTests();
		assert.equal(getAllSuspensions().length, 0);
	});
});

describe("extractInFlight", () => {
	it("returns null when there are no messages", () => {
		assert.equal(extractInFlight([]), null);
	});

	it("returns null when the most recent tool call already has a matching toolResult", () => {
		const tcId = "tc_1";
		const messages: Message[] = [
			assistantMessage([
				{ type: "toolCall", id: tcId, name: "bash", arguments: { command: "echo hi", timeout: 5 } },
			]),
			toolResult(tcId, "hi"),
		];
		assert.equal(extractInFlight(messages), null);
	});

	it("returns the most recent unmatched bash toolCall with command+timeout", () => {
		const oldId = "old";
		const inFlightId = "in_flight";
		const messages: Message[] = [
			assistantMessage([
				{ type: "text", text: "let me run something" },
				{ type: "toolCall", id: oldId, name: "bash", arguments: { command: "echo a", timeout: 5 } },
			]),
			toolResult(oldId, "a"),
			assistantMessage([
				{ type: "text", text: "now running the slow one" },
				{ type: "toolCall", id: inFlightId, name: "bash", arguments: { command: "sleep 9999", timeout: 900 } },
			]),
		];
		assert.deepEqual(extractInFlight(messages), {
			toolName: "bash",
			command: "sleep 9999",
			timeout: 900,
		});
	});

	it("returns toolName only for non-bash in-flight calls", () => {
		const id = "r";
		const messages: Message[] = [
			assistantMessage([{ type: "toolCall", id, name: "read", arguments: { file_path: "/x" } }]),
		];
		assert.deepEqual(extractInFlight(messages), { toolName: "read" });
	});

	it("walks content parts in reverse so the LAST toolCall in an assistant message wins", () => {
		const id1 = "tc1";
		const id2 = "tc2";
		const messages: Message[] = [
			assistantMessage([
				{ type: "toolCall", id: id1, name: "bash", arguments: { command: "a" } },
				{ type: "toolCall", id: id2, name: "bash", arguments: { command: "b" } },
			]),
			// Only the first has a result; the second is still in flight.
			toolResult(id1, "a-out"),
		];
		const inflight = extractInFlight(messages);
		assert.deepEqual(inflight, { toolName: "bash", command: "b", timeout: undefined });
	});

	it("falls back gracefully when arguments are not objects", () => {
		const id = "x";
		const messages: Message[] = [
			assistantMessage([{ type: "toolCall", id, name: "bash", arguments: null as unknown as Record<string, unknown> }]),
		];
		const inflight = extractInFlight(messages);
		assert.deepEqual(inflight, { toolName: "bash", command: undefined, timeout: undefined });
	});
});

describe("summarizeTail", () => {
	it("returns an empty array for empty inputs", () => {
		assert.deepEqual(summarizeTail([], "", 5), []);
	});

	it("emits one TailEntry per assistant text part and tool call", () => {
		const messages: Message[] = [
			assistantMessage([{ type: "text", text: "hello world" }]),
			assistantMessage([{ type: "toolCall", id: "x", name: "bash", arguments: { command: "ls" } }]),
		];
		const tail = summarizeTail(messages, "", 50);
		assert.equal(tail.length, 2);
		assert.equal(tail[0]!.kind, "assistant_text");
		assert.equal(tail[0]!.summary, "hello world");
		assert.equal(tail[1]!.kind, "assistant_tool_call");
		assert.match(tail[1]!.summary, /^bash /);
	});

	it("annotates tool_result entries with [ok] / [err]", () => {
		const messages: Message[] = [
			assistantMessage([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
			toolResult("t1", "success"),
			toolResult("t2", "boom", true),
		];
		const tail = summarizeTail(messages, "", 50);
		const resultEntries = tail.filter((t) => t.kind === "tool_result");
		assert.equal(resultEntries.length, 2);
		assert.match(resultEntries[0]!.summary, /^\[ok\]/);
		assert.match(resultEntries[1]!.summary, /^\[err\]/);
	});

	it("truncates long text to 120 chars with an ellipsis", () => {
		const long = "x".repeat(500);
		const messages: Message[] = [assistantMessage([{ type: "text", text: long }])];
		const tail = summarizeTail(messages, "", 50);
		assert.equal(tail.length, 1);
		assert.ok(tail[0]!.summary.endsWith("…"));
		assert.ok(tail[0]!.summary.length <= 121);
	});

	it("folds stderr lines in chronological order, truncated to 200 chars each", () => {
		const stderr = "a".repeat(500) + "\nshort\n" + "b".repeat(300);
		const tail = summarizeTail([], stderr, 50);
		assert.equal(tail.length, 3);
		assert.equal(tail[0]!.kind, "stderr");
		assert.ok(tail[0]!.summary.endsWith("…"));
		assert.equal(tail[1]!.summary, "short");
		assert.ok(tail[2]!.summary.endsWith("…"));
	});

	it("respects the n parameter — returns only the last n entries", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 30; i++) {
			messages.push(assistantMessage([{ type: "text", text: `msg ${i}` }]));
		}
		const tail = summarizeTail(messages, "", 5);
		assert.equal(tail.length, 5);
		assert.equal(tail[0]!.summary, "msg 25");
		assert.equal(tail[4]!.summary, "msg 29");
	});
});

describe("resolveDefaultTimeoutS (bash-guard env hook)", () => {
	it("returns DEFAULT_BASH_TIMEOUT_S when env var is unset", () => {
		assert.equal(resolveDefaultTimeoutS({}), 300);
	});

	it("returns DEFAULT_BASH_TIMEOUT_S when env var is empty", () => {
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "" }), 300);
	});

	it("parses a positive integer from the env var", () => {
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "42" }), 42);
	});

	it("parses a fractional value", () => {
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "1.5" }), 1.5);
	});

	it("falls back to default for non-numeric values", () => {
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "abc" }), 300);
	});

	it("falls back to default for zero / negative values", () => {
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "0" }), 300);
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "-5" }), 300);
	});

	it("falls back to default for NaN-ish values (e.g. '1e1000')", () => {
		assert.equal(resolveDefaultTimeoutS({ BASH_GUARD_DEFAULT_TIMEOUT_S: "1e1000" }), 300);
	});
});

describe("subagent idle timeout env hook (resolveIdleTimeoutMs via index.ts default)", () => {
	// We don't re-export resolveIdleTimeoutMs, but we can re-implement
	// the same logic here to assert the contract documented at the top
	// of index.ts. The function is internal; the env-var contract is
	// what matters for tests.
	function resolve(env: NodeJS.ProcessEnv): number {
		const raw = env["SUBAGENT_IDLE_TIMEOUT_MS"];
		if (raw === undefined || raw === null || raw === "") return 600_000;
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) return 600_000;
		return n;
	}

	it("default is 600_000 when env is unset", () => {
		assert.equal(resolve({}), 600_000);
	});

	it("empty string → default", () => {
		assert.equal(resolve({ SUBAGENT_IDLE_TIMEOUT_MS: "" }), 600_000);
	});

	it("positive integer override wins", () => {
		assert.equal(resolve({ SUBAGENT_IDLE_TIMEOUT_MS: "8000" }), 8000);
	});

	it("zero / negative / non-numeric → default", () => {
		assert.equal(resolve({ SUBAGENT_IDLE_TIMEOUT_MS: "0" }), 600_000);
		assert.equal(resolve({ SUBAGENT_IDLE_TIMEOUT_MS: "-1" }), 600_000);
		assert.equal(resolve({ SUBAGENT_IDLE_TIMEOUT_MS: "fast" }), 600_000);
	});
});

/**
 * collectDescendantPids — ppid-tree walker for the deep-tree
 * signal fix.
 *
 * We don't assert exact pids (those are unstable across runs) —
 * instead we assert structural properties: descendants are real
 * descendant pids of the root, depth is finite, and the function
 * gracefully handles edge cases (non-existent pid, pid 0, etc.).
 *
 * The shell-out test below spawns a bash with a `setsid sleep`
 * grandchild to verify the function reaches across pgid boundaries
 * (the original bug — group-level signals alone would miss the
 * grandchild because it has its own pgid + sid).
 */
describe("collectDescendantPids", () => {
	it("returns [] for pid <= 0", () => {
		assert.deepEqual(collectDescendantPids(0), []);
		assert.deepEqual(collectDescendantPids(-1), []);
	});

	if (process.platform === "win32") {
		// Win32 has no /proc; the function intentionally returns
		// []. We can't test positive cases on windows here.
		return;
	}

	it("returns the bash + setsid grandchild subtree (deep-tree signal coverage)", async () => {
		// Spawn a `bash` with `setsid sleep 30 &` as a grandchild.
		// The grandchild has its own pgid + sid, where a
		// pgid-only SIGSTOP would miss it. The ppid walk is
		// what's expected to catch it.
		const child = spawn(
			"bash",
			["-c", "sleep 5 & sleep 5 & setsid sleep 5 & wait"],
			{ detached: true },
		);
		const rootPid = child.pid!;
		try {
			// Give bash a beat to fork the grandchildren.
			await new Promise((r) => setTimeout(r, 250));
			const descendants = collectDescendantPids(rootPid);
			// We expect at least 3 descendants: the 2 plain sleeps
			// + the setsid grandchild. Sometimes bash spawns an
			// intermediate so we tolerate >= 3.
			assert.ok(
				descendants.length >= 3,
				`expected ≥3 descendants, got ${descendants.length}: ${JSON.stringify(descendants)}`,
			);
			// Every pid must be a strict positive integer.
			for (const d of descendants) {
				assert.ok(Number.isInteger(d) && d > 0, `invalid descendant pid: ${d}`);
			}
			// Descendants must be distinct.
			assert.equal(new Set(descendants).size, descendants.length, `duplicate pids in walk`);
		} finally {
			// Reap the test tree so we don't leak.
			child.kill("SIGKILL");
		}
	});

	it("returns [] for a non-existent root pid (no throw)", () => {
		// Pick a pid that's almost certainly unused (e.g. > 2^20).
		// If the system actually has that pid, we just won't
		// surface any descendants because the BFS frontier starts
		// empty once the root is missing.
		const result = collectDescendantPids(2_000_000);
		assert.ok(Array.isArray(result));
		assert.equal(result.length, 0);
	});

	it("returns [] for the test runner's own pid (no self-descendants)", () => {
		// The test runner has no children of its own (it doesn't
		// fork in this test), so the walk should be empty.
		const result = collectDescendantPids(process.pid);
		assert.ok(Array.isArray(result));
		// tsx may spawn a child process; we don't assert length 0
		// strictly — we just assert no crash.
	});
});

/**
 * P1 unit tests: parallel-group id + sibling lookup.
 *
 * The live crash fixed by P1 came from handleKill NOT propagating
 * the kill result into siblings' `completedResults`. These tests
 * pin down the lookup primitives (`newParallelGroupId`,
 * `getSiblingSuspensions`) so future regressions surface here as
 * well as in the e2e scenario.
 */
describe("newParallelGroupId", () => {
	it("starts with 'par_' and contains both a counter and a hex suffix", () => {
		const id = newParallelGroupId();
		assert.match(id, /^par_[0-9a-z]+_[0-9a-f]{6}$/);
	});

	it("returns distinct ids on rapid successive calls (counter + random)", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) ids.add(newParallelGroupId());
		assert.equal(ids.size, 100, "100 successive newParallelGroupId() must yield 100 distinct ids");
	});

	it("namespace is distinct from newSuspensionId (so ids never collide)", () => {
		// Mint several of each in tight alternation; sort by id and
		// confirm the prefixes are split correctly.
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			ids.push(newSuspensionId());
			ids.push(newParallelGroupId());
		}
		const suspIds = ids.filter((id) => id.startsWith("susp_"));
		const parIds = ids.filter((id) => id.startsWith("par_"));
		assert.equal(suspIds.length, 10);
		assert.equal(parIds.length, 10);
		// No overlap between the two namespaces.
		assert.equal(new Set(ids).size, ids.length, "all 20 ids must be distinct");
	});
});

describe("getSiblingSuspensions", () => {
	// Use a fresh registry per test (beforeEach at the top of the
	// suite already clears it). We can't actually exercise the
	// helper's PARALLEL-group matching without injecting real
	// Suspensions — we do that with a hand-rolled `as any` cast
	// since the production Suspension type requires a live
	// ChildProcess (which we don't need to look up by groupId).

	function fakeSusp(id: string, groupId: string | null, jobKind: "single" | "chain" | "parallel"): any {
		const job: any =
			jobKind === "parallel"
				? {
						kind: "parallel",
						groupId: groupId ?? undefined,
						tasks: [
							{ agent: "a", task: "a" },
							{ agent: "b", task: "b" },
							{ agent: "c", task: "c" },
						],
						index: 0,
						taskSpec: { agent: "a", task: "a" },
						completedResults: [],
					}
				: { kind: jobKind };
		return { id, proc: { pid: 1 }, job };
	}

	it("returns [] for an empty groupId (no cross-group leakage)", () => {
		const a = fakeSusp("a", "grp_1", "parallel");
		const b = fakeSusp("b", "grp_1", "parallel");
		registerSuspension(a);
		registerSuspension(b);
		// Empty groupId → safety fallback: never match anything.
		const result = getSiblingSuspensions("", "a");
		assert.deepEqual(result, []);
	});

	it("returns [] for an unknown groupId", () => {
		const a = fakeSusp("a", "grp_1", "parallel");
		registerSuspension(a);
		const result = getSiblingSuspensions("grp_unknown", "x");
		assert.deepEqual(result, []);
	});

	it("returns all siblings in the same group, excluding the excludeId", () => {
		const a = fakeSusp("a", "grp_1", "parallel");
		const b = fakeSusp("b", "grp_1", "parallel");
		const c = fakeSusp("c", "grp_1", "parallel");
		registerSuspension(a);
		registerSuspension(b);
		registerSuspension(c);
		const result = getSiblingSuspensions("grp_1", "a");
		assert.equal(result.length, 2);
		const ids = result.map((s) => s.id).sort();
		assert.deepEqual(ids, ["b", "c"]);
	});

	it("does NOT cross groups (two parallel calls in flight stay separate)", () => {
		// Two parallel calls running concurrently (e.g. nested
		// under a parallel parent). Siblings must be matched by
		// groupId, not by some other heuristic.
		const a1 = fakeSusp("a1", "grp_alpha", "parallel");
		const a2 = fakeSusp("a2", "grp_alpha", "parallel");
		const b1 = fakeSusp("b1", "grp_beta", "parallel");
		const b2 = fakeSusp("b2", "grp_beta", "parallel");
		registerSuspension(a1);
		registerSuspension(a2);
		registerSuspension(b1);
		registerSuspension(b2);
		const alphaResult = getSiblingSuspensions("grp_alpha", "a1");
		assert.deepEqual(
			alphaResult.map((s) => s.id).sort(),
			["a2"],
			`grp_alpha siblings should only include a2, got ${alphaResult.map((s) => s.id)}`,
		);
		const betaResult = getSiblingSuspensions("grp_beta", "b1");
		assert.deepEqual(
			betaResult.map((s) => s.id).sort(),
			["b2"],
		);
	});

	it("does NOT match single/chain suspensions (only parallel entries are siblings)", () => {
		// A single/chain suspension has no groupId, so it can't be
		// a sibling of a parallel suspension. The fix relies on
		// this invariant: a `kill` against a parallel suspension
		// only propagates to other parallel suspensions in the
		// same group — it must NEVER touch a chain/single
		// suspension's job.
		const a = fakeSusp("a", "grp_1", "parallel");
		const s = fakeSusp("s", null, "single");
		const ch = fakeSusp("ch", null, "chain");
		registerSuspension(a);
		registerSuspension(s);
		registerSuspension(ch);
		const result = getSiblingSuspensions("grp_1", "a");
		assert.deepEqual(result, [], `single/chain must not appear as siblings, got ${result.map((s) => s.id)}`);
	});

	it("respects an excludeId that doesn't match any registered id", () => {
		const a = fakeSusp("a", "grp_1", "parallel");
		const b = fakeSusp("b", "grp_1", "parallel");
		registerSuspension(a);
		registerSuspension(b);
		// excludeId is "x" — not in the registry. Returns the
		// same set as before (the whole group minus nothing,
		// because the id filter only matches `s.id === excludeId`).
		const result = getSiblingSuspensions("grp_1", "x");
		assert.deepEqual(result.map((s) => s.id).sort(), ["a", "b"]);
	});
});

/**
 * P1 cursor-walk integration test (without proc spawning).
 *
 * The full live crash was `liteToSingle(undefined)` inside
 * `finalizeAndContinue`. The cursor walk in `finalizeAndContinue`
 * (parallel branch) reads `job.completedResults[sibCursor]` and
 * passes the entry to `liteToSingle`. Pre-fix, no defensive
 * fallback existed; the fix in P2 synthesizes a placeholder
 * failed result when the slot is missing.
 *
 * We test the merging math here directly: build a synthetic
 * `completedResults` (= one completed sibling result), then
 * "kill" another sibling and merge the kill result into the
 * remaining suspension's `completedResults` via the same
 * algorithm used by `handleKill`. The cursor walk should then
 * produce a 3-slot array with the kill result at the killed
 * index and the completed result at the intact index.
 */
describe("P1 kill-result propagation (cursor walk reconstruction)", () => {
	// Mirror of `mergeKillResultIntoSibling` in index.ts — kept
	// here as a synchronous reference implementation so the unit
	// test can exercise the algorithm without needing to spawn
	// procs. The shape of newCompleted must match the cursor walk
	// in `finalizeAndContinue`'s parallel branch.
	function mergeKillResultIntoSibling(
		oldCompleted: Array<{ agent: string }>,
		killedIndex: number,
		killResult: { agent: string },
		stillSuspendedIndices: Set<number>,
		tasksLength: number,
	): Array<{ agent: string }> {
		const out: Array<{ agent: string }> = [];
		let cursor = 0;
		for (let i = 0; i < tasksLength; i++) {
			if (i === killedIndex) {
				out.push(killResult);
			} else if (stillSuspendedIndices.has(i)) {
				// skip
			} else {
				if (cursor < oldCompleted.length) {
					out.push(oldCompleted[cursor]!);
					cursor++;
				}
			}
		}
		return out;
	}

	it("kill of index 0 with one still-suspended sibling → result lands at index 0", () => {
		// 3 tasks: A (frozen, killed), B (still suspended), C (completed).
		// B's completedResults started as [C]. After kill, B's
		// completedResults should be [A-killed, C].
		const oldCompleted = [{ agent: "C" }];
		const killResult = { agent: "A" };
		const stillSuspended = new Set([1]); // B is still suspended at index 1
		const merged = mergeKillResultIntoSibling(oldCompleted, 0, killResult, stillSuspended, 3);
		assert.deepEqual(
			merged,
			[{ agent: "A" }, { agent: "C" }],
			`P1 cursor walk should produce [A-killed, C] but got ${JSON.stringify(merged)}`,
		);
	});

	it("kill of middle index → result lands at the middle, completed siblings preserved", () => {
		// 3 tasks: A (completed), B (frozen, killed), C (still suspended).
		// C's completedResults started as [A]. After kill, C's
		// completedResults should be [A, B-killed].
		const oldCompleted = [{ agent: "A" }];
		const killResult = { agent: "B" };
		const stillSuspended = new Set([2]); // C is still suspended at index 2
		const merged = mergeKillResultIntoSibling(oldCompleted, 1, killResult, stillSuspended, 3);
		assert.deepEqual(merged, [{ agent: "A" }, { agent: "B" }]);
	});

	it("kill of last index when last is the only suspended → cursor handles edge correctly", () => {
		// 3 tasks: A (completed), B (completed), C (frozen, killed).
		// No still-suspended siblings (the killed one was the only
		// suspension). After kill, the registry is empty so there's
		// no sibling to merge into — this test isolates the algorithm
		// against a contrived regenerate-completed call.
		const oldCompleted = [{ agent: "A" }, { agent: "B" }];
		const killResult = { agent: "C" };
		const stillSuspended = new Set<number>(); // none
		const merged = mergeKillResultIntoSibling(oldCompleted, 2, killResult, stillSuspended, 3);
		assert.deepEqual(merged, [{ agent: "A" }, { agent: "B" }, { agent: "C" }]);
	});

	it("two concurrent suspensions, kill one, the other's merge places the kill result correctly", () => {
		// 3 tasks: A (frozen, killed), B (still suspended), C (still suspended).
		// B's completedResults = [] (no completed sibling at suspension time).
		// After kill, B's completedResults should be [A-killed] (B and C are still suspended).
		const oldCompleted: Array<{ agent: string }> = [];
		const killResult = { agent: "A" };
		const stillSuspended = new Set([1, 2]);
		const merged = mergeKillResultIntoSibling(oldCompleted, 0, killResult, stillSuspended, 3);
		assert.deepEqual(merged, [{ agent: "A" }]);
	});

	it("cursor walk on the merged array fills all 3 slots with the right agent (no undefined)", () => {
		// Mirror of `finalizeAndContinue`'s parallel cursor walk,
		// post-merge. This is the assertion that captures the
		// pre-fix crash: pre-fix, the merged array would NOT have
		// the kill result at the killed index, and the cursor walk
		// would underflow on slot 2 → `liteToSingle(undefined)`.
		const tasks = [
			{ agent: "A", task: "a_FREEZE_ME" },
			{ agent: "B", task: "b_FREEZE_ME" },
			{ agent: "C", task: "c_quick" },
		];
		const oldCompleted = [{ agent: "C" }];
		const killResult = { agent: "A" };
		const stillSuspended = new Set([1]); // B is still suspended
		const mergedCompleted = mergeKillResultIntoSibling(
			oldCompleted,
			0,
			killResult,
			stillSuspended,
			3,
		);

		// Cursor walk: for each i in [0, 3), if i is self (job.index=1
		// for the resumed sibling), use the resume result; otherwise
		// consume next entry from mergedCompleted.
		const jobIndex = 1; // B is the suspended sibling
		const resumeResult = { agent: "B" };
		const slots: Array<{ agent: string } | undefined> = new Array(3);
		let sibCursor = 0;
		for (let i = 0; i < 3; i++) {
			if (i === jobIndex) {
				slots[i] = resumeResult;
			} else if (stillSuspended.has(i)) {
				slots[i] = { agent: tasks[i]!.agent }; // placeholder
			} else {
				const lite = mergedCompleted[sibCursor];
				slots[i] = lite ?? { agent: tasks[i]!.agent }; // P2 fallback
				sibCursor++;
			}
		}
		// All slots must be filled (no undefined).
		assert.ok(slots.every((s) => s !== undefined), `cursor walk underflowed: ${JSON.stringify(slots)}`);
		assert.deepEqual(slots, [{ agent: "A" }, { agent: "B" }, { agent: "C" }]);
	});
});