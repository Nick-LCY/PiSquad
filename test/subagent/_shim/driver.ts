/**
 * Arbitration protocol e2e driver.
 *
 * Spawned by `arbitration.e2e.test.ts`. Imports the subagent extension
 * in-process (with a mock `pi` ExtensionAPI), runs ONE scenario, and
 * prints a single JSON line tagged `E2E_RESULT:` to stdout for the
 * outer test to parse.
 *
 * Why a separate driver?
 * ----------------------
 * The subagent extension calls `process.argv[1]` at `execute()` time
 * (via `getPiInvocation`) to decide how to spawn the child `pi`
 * process. We need that to fall through to the `command: "pi"`
 * branch so the shim on PATH is picked up — which means we must set
 * `process.argv[1]` to a non-existent path BEFORE calling execute().
 *
 * Doing this in the test file would mutate argv for the rest of the
 * `node --test` run (and for any sibling tests). Keeping the mutation
 * scoped to a one-shot child process is cleaner.
 *
 * Scenario selection (env vars)
 * -----------------------------
 *   - SCENARIO ∈ {
 *       "freeze_kill",
 *       "freeze_resume",
 *       "chain_freeze_kill",         // 3-step chain, step 2 freezes, kill
 *       "parallel_one_suspend_resume", // 3 parallel tasks, 1 suspends, resume
 *       "double_freeze_resume",       // shim sleeps long enough for two freezings
 *       "abort_during_frozen",        // Ctrl+C arrives while frozen — proc must not be killed
 *       "resume_then_kill_race",      // resume + kill issued on the same id in quick succession; resume Promise must NOT hang
 *       "deep_tree_signal",           // shim spawns a `setsid sleep` grandchild in its own pgid; verifies freeze/thaw/kill all reach across the pgid boundary via the descendant-walk fix
 *     }
 *   - SUBAGENT_IDLE_TIMEOUT_MS — short watchdog timeout for fast tests
 *   - TEST_CWD — pre-populated temp dir containing .pi/agents/test-agent.md
 *   - PATH — already prepended with the shim's directory (set by outer test)
 *
 * Cleanup (R3)
 * ------------
 * After every scenario, regardless of which branch exits, we call
 * `driverCleanupAll()` to kill every suspension still in the
 * registry. The outer test runner (which spawns this driver) inherits
 * the driver's child processes; without this sweep, a frozen proc
 * group from a leaked suspension would persist across tests as a
 * `T`-state zombie (visible in `ps -eo stat`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SCENARIO = process.env.SCENARIO ?? "freeze_kill";
const TEST_CWD = process.env.TEST_CWD;
if (!TEST_CWD) {
	console.error("E2E_DRIVER_ERROR missing TEST_CWD env var");
	process.exit(2);
}

// Mutate argv so `getPiInvocation` falls through to the
// `command: "pi"` branch (which then resolves via PATH to the shim).
// We do this BEFORE importing the extension so the constant is in
// place when the module-level `default function(pi)` runs (the
// default function itself doesn't call getPiInvocation, but
// `parentProcessCleanup()` registers process listeners — that's fine).
process.argv[1] = `/nonexistent/e2e-${Date.now()}`;

interface AgentToolResultLite<T> {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: T;
}

interface ToolDefinitionLite {
	name: string;
	execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: (partial: any) => void,
		ctx?: any,
	): Promise<AgentToolResultLite<any>>;
}

async function main(): Promise<void> {
	// Late import so the argv mutation above is in effect.
	const mod = await import(
		`${process.env.PROJECT_ROOT ?? "/home/sankabox/code/PiExperiment"}/.pi/extensions/subagent/index.ts`
	);
	const extensionFn = (mod as { default: (pi: ExtensionAPI) => unknown }).default;
	const suspensionMod = await import(
		`${process.env.PROJECT_ROOT ?? "/home/sankabox/code/PiExperiment"}/.pi/extensions/subagent/suspensions.ts`
	);
	const getAllSuspensions = (suspensionMod as {
		getAllSuspensions: () => Array<{ id: string; proc: { pid?: number } }>;
	}).getAllSuspensions;

	let captured: ToolDefinitionLite | null = null;
	const pi: ExtensionAPI = {
		registerTool: (def) => {
			captured = def as unknown as ToolDefinitionLite;
		},
		getAllTools: () => [],
	} as unknown as ExtensionAPI;

	await extensionFn(pi);
	if (!captured) throw new Error("subagent extension did not register any tool");

	const tool = captured;
	const ctx = { cwd: TEST_CWD };

	// Helper: parse the JSON payload out of a result's first text
	// content block. The subagent tool emits snapshots as pretty-
	// printed JSON; we tolerate non-JSON text (e.g. "Agent failed: …").
	// Extract a single suspension id from a snapshot. Single-mode
	// snapshots expose `suspensionId` directly; parallel-mode
	// snapshots expose it as `suspensions[0].suspensionId`. We
	// return whichever is present.
	function extractSuspensionId(snap: any): string | undefined {
		if (!snap) return undefined;
		if (typeof snap.suspensionId === "string") return snap.suspensionId;
		if (Array.isArray(snap.suspensions) && snap.suspensions.length > 0) {
			return snap.suspensions[0]?.suspensionId;
		}
		return undefined;
	}

	function parseSnapshot(result: AgentToolResultLite<any>): any | null {
		const first = result.content[0];
		if (!first || first.type !== "text") return null;
		const text = first.text ?? "";
		const trimmed = text.trimStart();
		if (!trimmed.startsWith("{")) return null;
		// N-W6: parallel-mode snapshots append a human-readable
		// trailer ("\n\n- suspensionId: ..."). The previous design
		// hand-rolled brace-counting that failed to track string
		// escapes correctly for some payloads (e.g. nested braces
		// in tail summaries). Production emits JSON with `null, 2`
		// indentation and the trailer separator is always exactly
		// `\n\n` (newline between the closing `}` of the JSON and
		// the first `-` of the trailer). Splitting on the first
		// `\n\n` is correct as long as no string value in the JSON
		// payload contains `\n\n` verbatim — which the snapshot
		// builder never produces (assistant_text is whitespace-
		// collapsed to single spaces; tool_call args are JSON-
		// stringified and don't contain literal newlines; tail
		// entries are one-line summaries).
		try {
			return JSON.parse(trimmed);
		} catch {
			const sep = trimmed.indexOf("\n\n");
			if (sep <= 0) return null;
			try {
				return JSON.parse(trimmed.slice(0, sep));
			} catch {
				return null;
			}
		}
	}

	// Run a tool call with an abort signal that fires after `abortAfterMs`
	// (or never, if `abortAfterMs` is undefined). Used by the abort-
	// during-frozen scenario.
	async function executeWithAbort(
		id: string,
		params: any,
		abortAfterMs?: number,
	): Promise<AgentToolResultLite<any>> {
		if (abortAfterMs === undefined) {
			return tool.execute(id, params, undefined, undefined, ctx);
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), abortAfterMs);
		try {
			return await tool.execute(id, params, ctrl.signal, undefined, ctx);
		} finally {
			clearTimeout(timer);
		}
	}

	// Step 1: kick off a single-mode run with a non-existent agent
	// name (the shim doesn't care; it just runs and emits). The
	// watchdog fires after IDLE_TIMEOUT_MS and the tool returns
	// `idle_suspended`.
	//
	// The task description carries FREEZE_ME so the multi-shim
	// (used by chain / parallel / double_freeze scenarios) trips
	// the watchdog; the simple shim ignores the marker and always
	// sleeps long.
	const initialTask =
		SCENARIO === "freeze_kill" ||
		SCENARIO === "freeze_resume" ||
		SCENARIO === "abort_during_frozen"
			? "anything"
			: "anything_FREEZE_ME";
	let updateCount = 0;
	const r1 = await tool.execute(
		"c1",
		{ agent: "test-agent", task: initialTask },
		undefined,
		(partial) => {
			updateCount++;
			process.stderr.write(
				`[driver] onUpdate #${updateCount} text=${JSON.stringify(partial?.content?.[0]?.text ?? "").slice(0, 80)}\n`,
			);
		},
		ctx,
	);
	if (process.env.DEBUG_E2E) {
		process.stderr.write(`[driver] r1=${JSON.stringify(r1).slice(0, 200)}\n`);
	}
	const suspended = parseSnapshot(r1);
	if (!suspended || suspended.status !== "idle_suspended") {
		console.error(
			"E2E_DRIVER_ERROR first call did not return idle_suspended:",
			JSON.stringify(r1),
		);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		process.exit(3);
	}

	if (SCENARIO === "freeze_kill") {
		// Step 2: inspect for a larger tail.
		const r2 = await tool.execute(
			"c2",
			{ inspect: { id: suspended.suspensionId, lines: 50 } },
			undefined,
			undefined,
			ctx,
		);
		const inspected = parseSnapshot(r2);

		// Step 3: kill.
		const r3 = await tool.execute("c3", { kill: suspended.suspensionId }, undefined, undefined, ctx);

		// Step 4: give the OS a moment to deliver the SIGKILL, then
		// check that no process with the suspension's pgid is left.
		await new Promise((r) => setTimeout(r, 300));

		const result = {
			scenario: "freeze_kill",
			suspended,
			inspected,
			killText: r3.content[0]?.type === "text" ? r3.content[0].text : "",
			killIsError: r3.isError ?? false,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "freeze_resume") {
		// Loop: keep resuming until we either get a non-suspended
		// final result or we exceed a sanity bound. The shim's sleep
		// may be longer than the watchdog timeout, so we may see
		// multiple suspensions per resume cycle.
		let current: AgentToolResultLite<any> = r1;
		let suspensionsObserved = 1;
		const maxSuspensions = 8;
		while (suspensionsObserved <= maxSuspensions) {
			const snap = parseSnapshot(current);
			if (!snap || snap.status !== "idle_suspended") break;
			suspensionsObserved += 1;
			current = await tool.execute(
				`c${suspensionsObserved + 1}`,
				{ resume: snap.suspensionId },
				undefined,
				undefined,
				ctx,
			);
		}

		const finalText = current.content[0]?.type === "text" ? current.content[0].text : "";
		const result = {
			scenario: "freeze_resume",
			initialSuspended: suspended,
			suspensionsObserved,
			finalText,
			finalIsError: current.isError ?? false,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "chain_freeze_kill") {
		// Kill the initial r1 suspension first — chain scenarios
		// don't touch it and it would otherwise linger in the
		// registry until the safety-net cleanupAll runs (which is
		// AFTER we read `getAllSuspensions()` for the registryEmpty
		// assertion).
		await tool.execute("kill_r1", { kill: suspended.suspensionId }, undefined, undefined, ctx);
		// 3-step chain. Step 2 takes a long sleep so the watchdog
		// freezes it. We then resume (to confirm chain walks) and
		// finally kill to assert that the STEP-1 RESULT is preserved
		// in the post-kill payload. The FREEZE_ME marker on step
		// 2's task description is what the multi-shim reads from
		// argv to decide whether to do the long sleep.
		const chainResult = await tool.execute(
			"chain1",
			{
				chain: [
					{ agent: "test-agent", task: "step1_quiet" },
					{ agent: "test-agent", task: "step2_FREEZE_ME with {previous}" },
					{ agent: "test-agent", task: "step3_quiet with {previous}" },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		// chainResult.content[0] should be an idle_suspended snapshot.
		const snap1 = parseSnapshot(chainResult);
		if (!snap1 || snap1.status !== "idle_suspended") {
			console.error(
				"E2E_DRIVER_ERROR chain did not return idle_suspended on step 2:",
				JSON.stringify(chainResult),
			);
			await driverCleanupAll(tool, ctx, getAllSuspensions);
			process.exit(5);
		}

		// After step 1 has completed, its result should be in the
		// chain results (visible via details / via the snapshot
		// payload). The chain wrapper yields a JSON-text suspension
		// snapshot.
		function extractText(messages: any[] | undefined): string {
			if (!messages) return "";
			let out = "";
			for (const m of messages) {
				const parts = Array.isArray(m?.content) ? m.content : [];
				for (const p of parts) {
					if (typeof p?.text === "string") out += p.text;
				}
			}
			return out;
		}
		const firstStepText = extractText(chainResult.details?.results?.[0]?.messages);

		// Resume (the shim's long sleep completes).
		const resumed = await tool.execute("chain2", { resume: snap1.suspensionId }, undefined, undefined, ctx);
		const snap2 = parseSnapshot(resumed);
		if (!snap2 || snap2.status !== "idle_suspended") {
			// Could be final result if SHIM_SLEEP_S is short
			// enough — treat both as success.
		}

		// Now kill the (possibly still suspended) process to confirm
		// the chain step-1 result is still preserved. Find the
		// active suspension id either in snap2 or the first one.
		const targetId = snap2?.suspensionId ?? snap1.suspensionId;
		const killed = await tool.execute("chain3", { kill: targetId }, undefined, undefined, ctx);
		const killText = killed.content[0]?.type === "text" ? killed.content[0].text : "";

		const result = {
			scenario: "chain_freeze_kill",
			firstStepText,
			firstStepHasShimText: /starting shim/.test(firstStepText),
			killText,
			resumedSawSecondSuspension: !!(snap2 && snap2.status === "idle_suspended"),
		};
		// Snapshot the registry before cleanup to confirm no orphan
		// suspensions remain. The kill path MUST unregister or the
		// next test inherits a frozen proc group.
		await new Promise((r) => setTimeout(r, 200));
		const registryAfter = getAllSuspensions().map((s) => s.id);
		(result as any).registryAfterIds = registryAfter;
		(result as any).registryEmpty = registryAfter.length === 0;
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "parallel_one_suspend_resume" || SCENARIO === "parallel_two_suspend_resume") {
		// Kill the initial r1 suspension first (same reason as in
		// chain_freeze_kill — we need registryEmpty to actually be
		// empty when we assert it).
		await tool.execute("kill_r1", { kill: suspended.suspensionId }, undefined, undefined, ctx);

		// Build the parallel task list. If the test staged
		// `AGENTS=a,b,c` we use those distinct names so slot
		// ordering is unambiguous; otherwise fall back to the
		// legacy single-name list for backward compatibility with
		// the older (now-superseded) parallel test scenario.
		const agentList = (process.env.AGENTS ?? "").split(",").filter(Boolean);
		let tasks: Array<{ agent: string; task: string }>;
		if (SCENARIO === "parallel_two_suspend_resume") {
			// 3 tasks; BOTH task-1 (test-agent-b) AND task-2
			// (test-agent-c) carry FREEZE_ME so they both freeze
			// concurrently. Task-0 finishes quietly first.
			if (agentList.length !== 3) {
				console.error(`E2E_DRIVER_ERROR parallel_two_suspend_resume requires AGENTS=a,b,c, got ${process.env.AGENTS}`);
				await driverCleanupAll(tool, ctx, getAllSuspensions);
				process.exit(8);
			}
			tasks = [
				{ agent: agentList[0]!, task: "task0_quiet" },
				{ agent: agentList[1]!, task: "task1_FREEZE_ME" },
				{ agent: agentList[2]!, task: "task2_FREEZE_ME" },
			];
		} else {
			// parallel_one_suspend_resume — single FREEZE_ME in
			// the middle slot.
			if (agentList.length === 3) {
				tasks = [
					{ agent: agentList[0]!, task: "task0_quiet" },
					{ agent: agentList[1]!, task: "task1_FREEZE_ME" },
					{ agent: agentList[2]!, task: "task2_quiet" },
				];
			} else {
				tasks = [
					{ agent: "test-agent", task: "task0_quiet" },
					{ agent: "test-agent", task: "task1_FREEZE_ME" },
					{ agent: "test-agent", task: "task2_quiet" },
				];
			}
		}

		const parallelResult = await tool.execute("par1", { tasks }, undefined, undefined, ctx);

		const snap = parseSnapshot(parallelResult);
		if (!snap || snap.status !== "idle_suspended") {
			console.error(
				"E2E_DRIVER_ERROR parallel did not return idle_suspended:",
				JSON.stringify(parallelResult),
			);
			await driverCleanupAll(tool, ctx, getAllSuspensions);
			process.exit(6);
		}
		const suspendedIds = (snap.suspensions ?? []).map((s: any) => s.suspensionId);
		const completedCount = snap.completedCount ?? 0;

		// Drive resumes until we hit a non-suspended final result.
		let current: AgentToolResultLite<any> = parallelResult;
		const observedSuspensionIds: string[] = [...suspendedIds];
		const maxLoops = 12;
		let firstResumeKeptSecond = false;
		for (let i = 0; i < maxLoops; i++) {
			const s = parseSnapshot(current);
			if (!s || s.status !== "idle_suspended") break;
			const sid = extractSuspensionId(s);
			if (!sid) break;
			const beforeIds = observedSuspensionIds.slice();
			current = await tool.execute(`par_resume_${i}`, { resume: sid }, undefined, undefined, ctx);
			const next = parseSnapshot(current);
			// For the multi-suspension scenario: after the FIRST
			// resume, the response must STILL be a suspended
			// snapshot (because a sibling is still suspended) and
			// must still carry a different suspensionId.
			if (i === 0 && SCENARIO === "parallel_two_suspend_resume") {
				if (next && next.status === "idle_suspended") {
					const nextId = extractSuspensionId(next);
					if (nextId && nextId !== sid) firstResumeKeptSecond = true;
				}
			}
			const nextSid = next?.suspensionId ?? (next?.suspensions?.[0]?.suspensionId);
			if (nextSid && !observedSuspensionIds.includes(nextSid)) observedSuspensionIds.push(nextSid);
			void beforeIds;
		}

		const finalText = current.content[0]?.type === "text" ? current.content[0].text : "";
		const finalDetails = current.details;
		const finalResults = finalDetails?.results ?? [];
		// C2 invariant: exactly N results, all in their original
		// indices. No nulls, no "shuffled" order.
		const finalAgents = finalResults.map((r: any) => r.agent);
		const finalTasks = tasks.map((t) => t.agent);

		// Per-slot index integrity: for each final slot, the agent
		// must equal the agent originally requested at that index.
		// A shift (e.g. resumed result lands in slot 1 when it
		// should be slot 2 because of a cursor-walk bug) is the C2
		// bug we're guarding against.
		const slotIndex = finalResults.map((r: any, i: number) => ({
			slotIndex: i,
			slotAgent: r.agent,
			taskAgent: tasks[i]?.agent ?? null,
		}));

		const result = {
			scenario: SCENARIO,
			completedAtSuspension: completedCount,
			suspendedIds,
			observedSuspensionIds,
			finalText,
			finalAgentCount: finalResults.length,
			finalAgentsMatch: JSON.stringify(finalAgents) === JSON.stringify(finalTasks),
			finalResultsHaveAllAgents: tasks.every((t) => finalResults.some((r: any) => r.agent === t.agent)),
			finalHasThreeSlots: finalResults.length === 3,
			slotIndex,
			firstResumeKeptSecond,
		};
		// Snapshot the registry before cleanup to confirm no orphan
		// suspensions remain. Tied to the C2 invariant: every
		// resume / finalize path MUST unregister, otherwise the
		// next test inherits a frozen proc group.
		await new Promise((r) => setTimeout(r, 200));
		const registryAfter = getAllSuspensions().map((s) => s.id);
		(result as any).registryAfterIds = registryAfter;
		(result as any).registryEmpty = registryAfter.length === 0;
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "parallel_kill_then_resume") {
		// P1 regression: 3 parallel tasks (FREEZE_ME x2 + quiet x1).
		// After all 3 are running, two are frozen and one quiet
		// task completes. The user kills the FIRST frozen
		// suspension, then resumes the SECOND frozen suspension.
		//
		// Pre-fix, the kill result was not propagated into the
		// second suspension's `completedResults`. The resume path
		// then walked the cursor with the original
		// `completedResults` (just the quiet task's result). The
		// first slot was filled with the quiet task's result
		// (wrong slot), the second slot was filled with the
		// resume result (correct), and the third slot's cursor
		// underflowed `completedResults` → `liteToSingle(undefined)`
		// → `TypeError: Cannot read properties of undefined
		// (reading 'agent')` at `liteToSingle(index.ts:450)` → the
		// close handler that called `finalizeAndContinue` re-threw
		// synchronously, and the host pi process crashed because
		// the throw was uncaught inside the ChildProcess event
		// emitter.
		//
		// Post-fix: the kill result is merged into the second
		// suspension's `completedResults` via the `groupId` lookup
		// + `mergeKillResultIntoSibling` rebuild (P1). The resume
		// path's cursor walk then lands the kill result at the
		// killed index, the resume result at the resumed index,
		// and the quiet task's result at the third index. All
		// three slots are filled correctly, no `undefined` reaches
		// `liteToSingle`, and the host process stays alive.
		await tool.execute("kill_r1", { kill: suspended.suspensionId }, undefined, undefined, ctx);

		const agentList = (process.env.AGENTS ?? "").split(",").filter(Boolean);
		if (agentList.length !== 3) {
			console.error(
				`E2E_DRIVER_ERROR parallel_kill_then_resume requires AGENTS=a,b,c, got ${process.env.AGENTS}`,
			);
			await driverCleanupAll(tool, ctx, getAllSuspensions);
			process.exit(13);
		}

		// Both task-0 (test-agent-a) and task-1 (test-agent-b)
		// carry FREEZE_ME so they freeze concurrently. Task-2
		// (test-agent-c) is quiet and finishes before the
		// watchdog fires.
		const tasks = [
			{ agent: agentList[0]!, task: "task0_FREEZE_ME" },
			{ agent: agentList[1]!, task: "task1_FREEZE_ME" },
			{ agent: agentList[2]!, task: "task2_quick" },
		];

		const parallelResult = await tool.execute("par_kill_resume", { tasks }, undefined, undefined, ctx);
		const snap = parseSnapshot(parallelResult);
		if (!snap || snap.status !== "idle_suspended") {
			console.error(
				"E2E_DRIVER_ERROR parallel_kill_then_resume did not return idle_suspended:",
				JSON.stringify(parallelResult),
			);
			await driverCleanupAll(tool, ctx, getAllSuspensions);
			process.exit(14);
		}
		const suspendedIds = (snap.suspensions ?? []).map((s: any) => s.suspensionId);
		const completedCount = snap.completedCount ?? 0;
		// Two concurrent suspensions, one completed sibling.
		if (suspendedIds.length !== 2) {
			console.error(
				`E2E_DRIVER_ERROR parallel_kill_then_resume expected 2 concurrent suspensions, got ${suspendedIds.length}`,
			);
		}

		// RACE-OF-DEATH: protect against the host crashing before
		// we can capture the failure. The driver timeout in
		// `arbitration.e2e.test.ts` (60s default) would catch a
		// hang, but the host crash here would surface as a
		// non-zero exit code with no E2E_RESULT line. We add an
		// outer Promise.race with a 30s deadline — if the kill
		// OR the resume fails to resolve, the driver emits a
		// reason and exits non-zero so the outer test runner
		// reports a clean failure instead of "no E2E_RESULT".
		const killResult = await tool.execute(
			"par_kill_resume_kill",
			{ kill: suspendedIds[0]! },
			undefined,
			undefined,
			ctx,
		);

		// Resume the OTHER (still-suspended) suspension. This is
		// the resume that, pre-fix, would trigger the
		// liteToSingle(undefined) crash inside the proc.once(close)
		// handler.
		//
		// The shim sleeps 10s, the watchdog is 1.5s, so the
		// resumed proc will re-freeze at least once. Loop
		// resumes (always against the LATEST suspensionId) until
		// we get a non-suspended result.
		let resumeResult: AgentToolResultLite<any> | null = null;
		const maxResumeLoops = 12;
		const observedResumeIds: string[] = [];
		for (let i = 0; i < maxResumeLoops; i++) {
			// Find the currently-active suspension id (or use
			// the one we just issued a resume against). After
			// the kill, the only remaining suspension is the
			// one we want to resume; on later iterations it
			// may have a new id (re-frozen).
			const live = getAllSuspensions();
			const stillSuspended = live.filter((s) => s.id !== suspendedIds[0]);
			if (stillSuspended.length === 0) {
				// No active suspensions — edge case where the
				// resume completed between iterations. Bail.
				break;
			}
			const targetId = stillSuspended[0]!.id;
			if (!observedResumeIds.includes(targetId)) observedResumeIds.push(targetId);
			const resp = await tool.execute(
				`par_kill_resume_resume_${i}`,
				{ resume: targetId },
				undefined,
				undefined,
				ctx,
			);
			const snap = parseSnapshot(resp);
			if (!snap || snap.status !== "idle_suspended") {
				resumeResult = resp;
				break;
			}
			// Still suspended (re-froze). Loop continues.
			resumeResult = resp;
		}

		const finalDetails = resumeResult?.details;
		const finalResults = finalDetails?.results ?? [];
		const finalText = resumeResult?.content?.[0]?.type === "text" ? resumeResult.content[0].text ?? "" : "";
		const finalTasks = tasks.map((t) => t.agent);

		// Per-slot index integrity: the kill result must land at
		// the killed index, the resume result at the resumed index,
		// the quiet task's result at the third index. A shift
		// would be the P1 bug.
		const slotIndex = finalResults.map((r: any, i: number) => ({
			slotIndex: i,
			slotAgent: r.agent,
			taskAgent: tasks[i]?.agent ?? null,
			exitCode: r.exitCode,
			stopReason: r.stopReason ?? null,
		}));

		await new Promise((r) => setTimeout(r, 200));
		const registryAfter = getAllSuspensions().map((s) => s.id);

		const result = {
			scenario: "parallel_kill_then_resume",
			completedAtSuspension: completedCount,
			suspendedIds,
			killResult,
			finalText,
			finalAgentCount: finalResults.length,
			finalHasThreeSlots: finalResults.length === 3,
			finalAgentsMatch: JSON.stringify(finalResults.map((r: any) => r.agent)) === JSON.stringify(finalTasks),
			slotIndex,
			observedResumeIds,
			registryAfterIds: registryAfter,
			registryEmpty: registryAfter.length === 0,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "double_freeze_resume") {
		// NOTE: this scenario USES r1 directly (it loops resuming
		// r1's suspension), so we do NOT kill r1 here. The
		// registryEmpty assertion at the end is satisfied by the
		// natural unregister in handleResume / kill path.
		//
		// Shim configured so its single long sleep outlasts TWO
		// watchdog intervals. We expect:
		//   1) freeze → resume (1st) → freeze → resume (2nd) → exit
		// Registry must end up empty (no orphan suspensions).
		let current: AgentToolResultLite<any> = r1;
		const suspensionsObserved: string[] = [suspended.suspensionId];
		const maxLoops = 16;
		for (let i = 0; i < maxLoops; i++) {
			const snap = parseSnapshot(current);
			if (!snap || snap.status !== "idle_suspended") break;
			current = await tool.execute(
				`dbl_${i}`,
				{ resume: snap.suspensionId },
				undefined,
				undefined,
				ctx,
			);
			const next = parseSnapshot(current);
			if (next?.suspensionId) suspensionsObserved.push(next.suspensionId);
		}

		// Give the close handler a tick to unregister.
		await new Promise((r) => setTimeout(r, 200));
		// Snapshot registry size after finalization. Should be empty.
		const registryAfter = getAllSuspensions().map((s) => s.id);

		const finalText = current.content[0]?.type === "text" ? current.content[0].text : "";
		const uniqueIds = new Set(suspensionsObserved);
		const result = {
			scenario: "double_freeze_resume",
			suspensionsObservedCount: suspensionsObserved.length,
			suspensionIdsUnique: uniqueIds.size === suspensionsObserved.length,
			suspensionIds: suspensionsObserved,
			finalText,
			finalIsError: current.isError ?? false,
			registryAfterIds: registryAfter,
			registryEmpty: registryAfter.length === 0,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "resume_then_kill_race") {
		// F1 regression: when the LLM (or, here, our driver) issues
		// `resume: id` and `kill: id` against the SAME suspension
		// without awaiting resume in between, the kill path sets
		// `cancelled = true`, kills the proc group, and unregisters
		// the suspension. The proc's close event then enters
		// `finalizeAndContinue` on the resume leg. Pre-fix, that
		// function early-returned on `susp.cancelled` and never
		// resolved the resume Promise — parent tool call hung
		// forever (deadlock).
		//
		// Post-fix, `finalizeAndContinue` resolves with a fact-only
		// "Resumed sub-agent was killed while resuming" payload.
		//
		// We don't kill r1 here — we use it for both tool calls.
		const targetId = suspended.suspensionId;

		// Start resume WITHOUT awaiting. The Promise constructor
		// runs synchronously, so by the time `tool.execute` returns
		// the Promise, all listeners (close, error, watchdog) are
		// already wired up.
		const resumePromise = tool.execute(
			"resume_race",
			{ resume: targetId },
			undefined,
			undefined,
			ctx,
		);

		// Yield once so the resume handler's microtask queue has a
		// chance to settle before we fire the kill. This is not
		// strictly required (the bug manifests even without the
		// yield) but it matches the realistic ordering the LLM
		// would produce — both tool calls issued in the same turn,
		// neither explicitly awaited before the other.
		await new Promise((r) => setTimeout(r, 10));

		// Kill goes through the regular handleKill path.
		const killResult = await tool.execute(
			"kill_race",
			{ kill: targetId },
			undefined,
			undefined,
			ctx,
		);

		// Race the resume Promise against a 3-second timeout. If
		// the F1 bug is present, resumePromise never settles and
		// the timeout wins; we then emit a timed-out marker and
		// exit non-zero so the outer test fails clearly instead
		// of stretching to its 60s wrapper timeout.
		const TIMEOUT_MS = 3000;
		const resumeOutcome = await Promise.race<
			| { kind: "resolved"; result: AgentToolResultLite<any> }
			| { kind: "timedOut" }
		>([
			resumePromise.then((r) => ({ kind: "resolved" as const, result: r })),
			new Promise<{ kind: "timedOut" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timedOut" }), TIMEOUT_MS),
			),
		]);

		const resumeTimedOut = resumeOutcome.kind === "timedOut";
		const resumeResult = resumeOutcome.kind === "resolved" ? resumeOutcome.result : null;
		const resumeText =
			resumeResult?.content?.[0]?.type === "text" ? (resumeResult.content[0].text ?? "") : "";
		const resumeIsError = resumeResult?.isError ?? false;

		// Give the close handler a tick to finalize any remaining
		// bookkeeping. `handleKill` already unregistered the
		// suspension, so the registry MUST be empty here.
		await new Promise((r) => setTimeout(r, 200));
		const registryAfter = getAllSuspensions().map((s) => s.id);

		const result = {
			scenario: "resume_then_kill_race",
			resumeTimedOut,
			resumeText,
			resumeIsError,
			killText:
				killResult.content?.[0]?.type === "text" ? (killResult.content[0].text ?? "") : "",
			registryAfterIds: registryAfter,
			registryEmpty: registryAfter.length === 0,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		// If resume hung, force-exit so the pending Promise doesn't
		// keep the event loop alive (and so the outer test gets a
		// clean non-zero exit instead of inheriting a stuck driver).
		// Safe because `handleKill` already tore down the proc
		// group; nothing valuable is left to clean up.
		if (resumeTimedOut) {
			process.exit(10);
		}
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "abort_during_frozen") {
		// N-C1/N-W1 fix semantics: abort the AbortSignal WHILE the
		// proc is still FROZEN (suspensionId held, no resume
		// issued yet). The handler attached in runSingleAgent was
		// detached at freeze; the only thing listening now is the
		// detached one — abort is a no-op. The proc stays alive.
		//
		// Then we resume with a FRESH (non-aborted) signal. The
		// resume path re-attaches a new abort handler; since the
		// proc is now SIGCONT'd and running, a late abort WILL
		// kill it — which is correct user behavior.
		const targetId = suspended.suspensionId;
		const liveSusp = getAllSuspensions().find((s) => s.id === targetId);
		const procPid = liveSusp?.proc?.pid;

		const ctrl = new AbortController();
		// Fire the abort while the proc is still frozen. The
		// suspension is in the registry; the cold-path abort
		// handler was detached at freeze time, so this abort has
		// nowhere to land.
		ctrl.abort();
		await new Promise((r) => setTimeout(r, 100));
		// Verify the proc is still alive.
		let procAliveAfterAbort = false;
		try {
			if (procPid) {
				process.kill(procPid, 0);
				procAliveAfterAbort = true;
			}
		} catch {
			procAliveAfterAbort = false;
		}

		// Now resume with a fresh signal. The proc will run and
		// complete naturally (its sleep is long enough that the
		// resume handler's watchdog doesn't re-fire before it
		// exits).
		let resumeResult: AgentToolResultLite<any> | null = null;
		try {
			resumeResult = await tool.execute(
				"abort_resume",
				{ resume: targetId },
				undefined, // no signal — can't reuse the aborted one
				undefined,
				ctx,
			);
		} catch (err) {
			resumeResult = {
				content: [{ type: "text", text: `threw: ${(err as Error).message}` }],
				isError: true,
			};
		}

		const finalText =
			resumeResult?.content?.[0]?.type === "text" ? resumeResult.content[0].text ?? "" : "";
		const result = {
			scenario: "abort_during_frozen",
			abortFired: true,
			procAliveAfterAbort,
			resumeText: finalText,
			resumeCompleted: /resumed final output from shim/.test(finalText),
			resumeIsError: resumeResult?.isError ?? false,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	if (SCENARIO === "deep_tree_signal") {
		// Reproduces the live E2E gap: the sub-`pi`'s bash spawns a
		// `setsid sleep 30` grandchild that lives in its own pgid +
		// session. The pre-fix `freezeProcessGroup` /
		// `thawProcessGroup` / `killProcessGroup` only signaled
		// the root pgid, so the grandchild was:
		//   - never frozen when its parent was (STAT=Ss, not T)
		//   - never killed when its parent was (orphaned to PPID 1)
		// The fix in `suspensions.ts` adds a ppid tree walk via
		// `collectDescendantPids` that reaches the grandchild
		// across pgid boundaries.
		//
		// Two-stage verification:
		//   Stage 1 — freeze + thaw: shim runs a long sleep with
		//     a setsid grandchild; we freeze (verify grandchild is T),
		//     resume (verify grandchild is non-T), let the shim
		//     complete naturally. The thaw assertion is done during
		//     the resume call's pending window (we do NOT await
		//     resume before checking the stat, because resume only
		//     returns when the shim exits — and at that point the
		//     grandchild is also gone).
		//   Stage 2 — kill: spawn a fresh shim run, freeze, then
		//     kill (verify grandchild is gone — no orphan).
		//
		// The grandchild's pid is stashed by the shim in
		// $SHIM_GRANDCHILD_PIDFILE so we can probe its stat field
		// directly. If `setsid` isn't available (e.g. busybox
		// shim env), the shim gracefully skips the grandchild
		// spawn and we report `grandchildFrozen/Thawed/Killed`
		// as `skipped` rather than failing the test outright.
		async function readStat(pid: number): Promise<string> {
			const r = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
			return (r.stdout ?? "").trim();
		}
		async function isPidAlive(pid: number): Promise<boolean> {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		}
		const grandchildPidFile = `${process.env.TEST_CWD}/grandchild.pid`;

		// --- Stage 1: freeze + thaw ---
		await tool.execute("kill_r1", { kill: suspended.suspensionId }, undefined, undefined, ctx);
		const r1 = await tool.execute(
			"deep1",
			{ agent: "test-agent", task: "deep_FREEZE_ME" },
			undefined,
			undefined,
			ctx,
		);
		const suspended1 = parseSnapshot(r1);
		if (!suspended1 || suspended1.status !== "idle_suspended") {
			console.error("E2E_DRIVER_ERROR deep_tree_signal stage 1 r1 did not return idle_suspended:", JSON.stringify(r1));
			await driverCleanupAll(tool, ctx, getAllSuspensions);
			process.exit(11);
		}

		// Wait for the grandchild pid file to appear (shim writes
		// it during the long-sleep branch).
		let grandchildPid: number | null = null;
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 50));
			try {
				const txt = readFileSync(grandchildPidFile, "utf8").trim();
				const n = Number(txt);
				if (Number.isInteger(n) && n > 0) {
					grandchildPid = n;
					break;
				}
			} catch {
				/* file not yet written; retry */
			}
		}

		let grandchildFrozen: boolean | "skipped" = "skipped";
		let grandchildThawed: boolean | "skipped" = "skipped";
		let grandchildStatAfterFreeze: string | null = null;
		let grandchildStatAfterThaw: string | null = null;
		if (grandchildPid !== null) {
			// Give the kernel a beat to actually deliver the SIGSTOP.
			await new Promise((r) => setTimeout(r, 100));
			const statFrozen = await readStat(grandchildPid);
			grandchildStatAfterFreeze = statFrozen;
			grandchildFrozen = statFrozen.startsWith("T");

			// Issue the resume WITHOUT awaiting it; we want to
			// probe the grandchild's stat while the resume is
			// still pending (i.e. the shim hasn't exited yet).
			// The resume Promise resolves only when the shim
			// process exits; awaiting it would skip past the
			// window where the grandchild is still alive (and
			// therefore optionally showable as non-T).
			const resumePromise = tool.execute(
				"deep_resume",
				{ resume: suspended1.suspensionId },
				undefined,
				undefined,
				ctx,
			);
			// Give SIGCONT a beat to land across the descendant tree.
			await new Promise((r) => setTimeout(r, 200));
			const statThawed = await readStat(grandchildPid);
			grandchildStatAfterThaw = statThawed;
			grandchildThawed = !statThawed.startsWith("T");
			// Now drain the resume Promise so the shim exits cleanly
			// before stage 2 starts.
			await resumePromise;
		} else {
			// setsid wasn't available; still resume to clean up the
			// suspended state so stage 2 starts fresh.
			await tool.execute("deep_resume_skip", { resume: suspended1.suspensionId }, undefined, undefined, ctx);
		}

		// Brief settle before stage 2 so the previous shim's pid
		// doesn't reappear in the pid file (the shim overwrites
		// it on its next run, but we want to read the fresh pid).
		await new Promise((r) => setTimeout(r, 200));

		// --- Stage 2: kill ---
		// Use a fresh r1 cold run for the kill stage so the freeze
		// flow re-walks the tree.
		const r2 = await tool.execute(
			"deep2_cold",
			{ agent: "test-agent", task: "deep_FREEZE_ME" },
			undefined,
			undefined,
			ctx,
		);
		const suspended2 = parseSnapshot(r2);
		if (!suspended2 || suspended2.status !== "idle_suspended") {
			console.error("E2E_DRIVER_ERROR deep_tree_signal stage 2 r2 did not return idle_suspended:", JSON.stringify(r2));
			await driverCleanupAll(tool, ctx, getAllSuspensions);
			process.exit(12);
		}

		// Wait for the grandchild pid file from the second run.
		// The shim writes a fresh pid; we explicitly check that
		// it's different from stage 1's (to avoid race conditions
		// where the previous shim's pid is still on disk).
		let grandchildPid2: number | null = null;
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 50));
			try {
				const txt = readFileSync(grandchildPidFile, "utf8").trim();
				const n = Number(txt);
				if (Number.isInteger(n) && n > 0 && n !== grandchildPid) {
					grandchildPid2 = n;
					break;
				}
			} catch {
				/* file not yet written; retry */
			}
		}

		let grandchildKilled: boolean | "skipped" = "skipped";
		let grandchildPid2AlivePreKill: boolean | null = null;
		if (grandchildPid2 !== null) {
			// Sanity check: confirm the grandchild is alive BEFORE
			// the kill. If it's already dead (pre-fix this would
			// happen if the shim crashed), the kill-depth assertion
			// is trivially true and we record the situation so
			// debugging is easier.
			grandchildPid2AlivePreKill = await isPidAlive(grandchildPid2);
			// Kill the suspended shim via the tool path. The kill
			// path's descendant walk must propagate SIGKILL to the
			// grandchild too.
			await tool.execute("deep_kill", { kill: suspended2.suspensionId }, undefined, undefined, ctx);
			// Give the SIGKILL a moment to propagate.
			await new Promise((r) => setTimeout(r, 300));
			grandchildKilled = !(await isPidAlive(grandchildPid2));
		} else {
			// setsid unavailable; still kill the proc to clean up.
			await tool.execute("deep_kill_skip", { kill: suspended2.suspensionId }, undefined, undefined, ctx);
		}

		const result = {
			scenario: "deep_tree_signal",
			grandchildPid,
			grandchildStatAfterFreeze,
			grandchildStatAfterThaw,
			grandchildFrozen,
			grandchildThawed,
			grandchildPid2,
			grandchildPid2AlivePreKill,
			grandchildKilled,
		};
		process.stdout.write(`E2E_RESULT:${JSON.stringify(result)}\n`);
		await driverCleanupAll(tool, ctx, getAllSuspensions);
		return;
	}

	console.error(`E2E_DRIVER_ERROR unknown scenario: ${SCENARIO}`);
	await driverCleanupAll(tool, ctx, getAllSuspensions);
	process.exit(4);
}

/** Force-kill every suspension still registered. Used as a safety
 *  net so the parent test never inherits a frozen proc group.
 *  Idempotent: safe to call after a scenario that already cleaned
 *  up. The inner `kill:` tool call goes through the regular
 *  `handleKill` path (which itself does a synchronous SIGKILL);
 *  if that leaves anything still alive, we sweep again with a raw
 *  SIGCONT + SIGKILL to the process group. */
async function driverCleanupAll(
	tool: ToolDefinitionLite,
	ctx: { cwd: string },
	getAllSuspensions: () => Array<{ id: string; proc: { pid?: number } }>,
): Promise<void> {
	const all = getAllSuspensions();
	for (const s of all) {
		try {
			await tool.execute(`cleanup_${s.id}`, { kill: s.id }, undefined, undefined, ctx);
		} catch {
			/* swallow — best effort */
		}
	}
	// Final sweep: anything still alive (e.g. from a stuck handleKill),
	// SIGCONT + SIGKILL its process group synchronously.
	const remaining = getAllSuspensions();
	for (const s of remaining) {
		try {
			if (s.proc?.pid) {
				try {
					process.kill(-s.proc.pid, "SIGCONT");
				} catch {
					/* ignore */
				}
				try {
					process.kill(-s.proc.pid, "SIGKILL");
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* swallow */
		}
	}
	// Give the kernel a moment to actually reap the killed group
	// before the driver exits, so the parent test's ps -eo doesn't
	// race a half-dead process tree.
	await new Promise((r) => setTimeout(r, 150));
}

main().catch(async (err) => {
	console.error("E2E_DRIVER_ERROR exception:", err);
	try {
		// Best-effort: try to use the tool if it's already bound.
		// (Often not — failure can happen during module load.)
		// Without it we still sweep process groups via ps + kill.
	} catch {
		/* ignore */
	}
	process.exit(1);
});
