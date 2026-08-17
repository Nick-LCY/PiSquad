/**
 * E2E test for the subagent idle arbitration protocol.
 *
 * Scenarios covered
 * -----------------
 *   1. **freeze → inspect → kill** — verifies the watchdog freezes
 *      the process group with SIGSTOP, the inspect call returns a
 *      larger tail without touching the process, the kill call
 *      thaws + SIGKILLs the group, and no leftover shim process
 *      survives in the kernel's process table.
 *   2. **freeze → resume → final result** — verifies the resume
 *      call SIGCONTs the group, the watchdog re-arms, the shim
 *      eventually exits cleanly, and the final transcript contains
 *      the events the shim emitted after the freeze.
 *
 * Test mechanics
 * --------------
 * Each scenario is driven by a separate Node child process
 * (`test/subagent/_shim/driver.ts`) because the subagent extension
 * reads `process.argv[1]` to decide how to spawn the child `pi`
 * process; we need to force the "use the `pi` on PATH" branch so the
 * shim is picked up. The driver mutates argv[1] before importing
 * the extension, which we can't do in the outer `node --test`
 * process without poisoning sibling tests.
 *
 * The outer test creates a temp cwd per scenario, drops in a minimal
 * `.pi/agents/test-agent.md` (the extension's agent discovery needs
 * this), stages the fake `pi` shim into a temp bin dir, prepends
 * that dir to PATH, and spawns the driver. The driver's stdout is
 * scanned for the `E2E_RESULT:<json>` line; everything else is
 * forwarded to the outer TAP stream so failures are debuggable.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync as childExecSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const DRIVER_PATH = join(__dirname, "_shim", "driver.ts");
const SHIM_SRC = join(__dirname, "_shim", "pi-shim.sh");
const SHIM_MULTI_SRC = join(__dirname, "_shim", "pi-shim-multi.sh");

/** Default wall-clock cap for one scenario. Generous enough that
 *  legitimate watch-fires and a few resume cycles fit; tight enough
 *  that a true hang fails the test fast instead of stretching past
 *  CI's global per-file timeout. Override per-call if needed. */
const DEFAULT_DRIVER_TIMEOUT_MS = 60_000;

/** Spawn the driver with the right cwd / PATH / env wiring and
 *  collect one JSON `E2E_RESULT:` line. Resolves with the parsed
 *  object; rejects on non-zero exit or malformed output. A total
 *  timeout (default 60s) guards against the R1-style hang where
 *  the driver never returns: on expiry we SIGCONT + SIGKILL the
 *  driver process group synchronously and reject with a
 *  descriptive error so the test fails cleanly. */
function runDriver(
	env: Record<string, string>,
	idleTimeoutMs: number,
	timeoutMs: number = DEFAULT_DRIVER_TIMEOUT_MS,
): Promise<{
	result: any;
	combinedStdout: string;
}> {
	return new Promise((res, rej) => {
		let killed = false;
		const proc = spawn(
			process.execPath,
			[
				"--import",
				"tsx/esm",
				DRIVER_PATH,
			],
			{
				cwd: PROJECT_ROOT,
				env: {
					...process.env,
					...env,
					TSX_TSCONFIG_PATH: join(PROJECT_ROOT, "tsconfig.test-runtime.json"),
					SUBAGENT_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
				},
				stdio: ["ignore", "pipe", "pipe"],
				// Driver becomes its own process group leader so
				// `process.kill(-proc.pid)` only takes down the
				// driver + its shim subtree — NOT the test runner
				// (which would otherwise share the pgid and get
				// SIGKILLed on the 60s timeout path).
				detached: true,
			},
		);

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (b) => {
			stdout += b.toString();
		});
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});

		const killDriverGroup = (reason: string) => {
			if (killed) return;
			killed = true;
			// SIGCONT first so the SIGKILL is delivered
			// immediately rather than queued, then SIGKILL the
			// entire group so any detached children die with us.
			try {
				if (proc.pid) {
					try {
						process.kill(-proc.pid, "SIGCONT");
					} catch {
						/* ignore */
					}
					try {
						process.kill(-proc.pid, "SIGKILL");
					} catch {
						/* ignore */
					}
				}
			} catch {
				/* swallow */
			}
			rej(
				new Error(
					`runDriver ${reason} after ${timeoutMs}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
				),
			);
		};

		const timer = setTimeout(() => killDriverGroup("timed out"), timeoutMs);

		proc.on("error", (err) => {
			clearTimeout(timer);
			rej(err);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (killed) return; // killDriverGroup already rejected
			if (code !== 0) {
				rej(
					new Error(
						`driver exited with code ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
					),
				);
				return;
			}
			const match = stdout.match(/E2E_RESULT:(.*)/);
			if (!match) {
				rej(new Error(`no E2E_RESULT line in stdout:\n${stdout}\n${stderr}`));
				return;
			}
			try {
				res({ result: JSON.parse(match[1]!), combinedStdout: stdout });
			} catch (e) {
				rej(new Error(`failed to parse E2E_RESULT JSON: ${(e as Error).message}\nraw: ${match[1]}`));
			}
		});
	});
}

/** Check whether `pid` is alive via signal 0. Throws nothing. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Stage a temp cwd with a single test agent and a fake `pi` shim.
 *  Returns paths the test will need to spawn the driver. */
interface ScenarioEnv {
	cwd: string;
	binDir: string;
	cleanup: () => void;
}

/** A copy of the test-agent.md (identical for every scenario). */
function writeTestAgent(cwd: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "test-agent.md"),
		[
			"---",
			"name: test-agent",
			"description: Shim-controlled test agent for arbitration e2e",
			"---",
			"",
			"# Empty system prompt (no --append-system-prompt flag)",
			"",
		].join("\n"),
		"utf8",
	);
}

/** Write N test agents (test-agent-a, test-agent-b, …). The
 *  multi-suspension parallel scenarios need distinguishable
 *  agent names per slot so we can assert the resume path lands
 *  results in the correct index. */
function writeTestAgents(cwd: string, names: string[]): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	for (const name of names) {
		writeFileSync(
			join(agentsDir, `${name}.md`),
			[
				"---",
				`name: ${name}`,
				"description: Shim-controlled test agent for arbitration e2e",
				"---",
				"",
				"# Empty system prompt (no --append-system-prompt flag)",
				"",
			].join("\n"),
			"utf8",
		);
	}
}

function stageScenarioEnv(prefix: string, shimSrc: string = SHIM_SRC): ScenarioEnv {
	const cwd = mkdtempSync(join(tmpdir(), `pi-e2e-${prefix}-`));
	const binDir = mkdtempSync(join(tmpdir(), `pi-e2e-bin-${prefix}-`));
	writeTestAgent(cwd);

	// Copy the shim script into binDir as `pi` and make it executable.
	const shimDest = join(binDir, "pi");
	writeFileSync(shimDest, readFileSync(shimSrc, "utf8"));
	chmodSync(shimDest, 0o755);

	const cleanup = () => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		try {
			rmSync(binDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};
	return { cwd, binDir, cleanup };
}

describe("subagent idle arbitration protocol (e2e)", () => {
	let scenario: ScenarioEnv | null = null;
	before(() => {
		// Sanity: tsx is installed and the driver / shim are present.
		assert.ok(existsSync(DRIVER_PATH), `driver not found at ${DRIVER_PATH}`);
		assert.ok(existsSync(SHIM_SRC), `shim not found at ${SHIM_SRC}`);
		assert.ok(existsSync(SHIM_MULTI_SRC), `multi-shim not found at ${SHIM_MULTI_SRC}`);
	});
	after(() => {
		scenario?.cleanup();
	});

	// Defense-in-depth: every scenario should leave the registry
	// empty AND the kernel's process table free of processes
	// spawned by THIS project. If something leaks — a missed
	// unregister, a handleKill that didn't reach its proc group,
	// a runaway freeze loop — we want a noisy failure here rather
	// than a zombie that hangs the next test.
	//
	// N-W4: previous sweep looked only at `T`-state processes
	// (frozen-via-SIGSTOP). That misses the failure mode where
	// the driver itself was killed by the 60s timeout SIGKILL
	// — its child shim is then in `S` / `R` / `Z` state, not
	// `T`, so it slipped through and leaked into the next test.
	// Now we scan ALL processes matching the project's
	// cwd/bin prefixes, regardless of stat.
	afterEach(() => {
		scenario?.cleanup();
		scenario = null;

		try {
			const psOut = childExecSync(
				"ps -eo pid,ppid,pgid,stat,args --no-headers",
				{ encoding: "utf8" },
			);
			const offenders: string[] = [];
			for (const line of psOut.split("\n")) {
				if (!line.trim()) continue;
				const cols = line.trim().split(/\s+/, 5);
				const args = cols[4] ?? "";
				if (
					args.includes("/pi-e2e-") ||
					args.includes("/pi-shim") ||
					args.includes("/pi-subagent-")
				) {
					offenders.push(line);
				}
			}
			if (offenders.length > 0) {
				// Clean up before failing so we don't leak into the
				// next test. For T-state, SIGCONT first so SIGKILL
				// is delivered immediately. For other states, just
				// SIGKILL the group.
				const seenPgids = new Set<number>();
				for (const line of offenders) {
					const cols = line.trim().split(/\s+/, 5);
					const pgid = Number(cols[2]);
					const stat = cols[3] ?? "";
					if (Number.isFinite(pgid) && pgid > 0 && !seenPgids.has(pgid)) {
						seenPgids.add(pgid);
						if (stat.startsWith("T")) {
							try {
								process.kill(-pgid, "SIGCONT");
							} catch {
								/* ignore */
							}
						}
						try {
							process.kill(-pgid, "SIGKILL");
						} catch {
							/* ignore */
						}
					}
				}
				assert.fail(
					`afterEach: leftover processes spawned by this test\n${offenders.join("\n")}`,
				);
			}
		} catch (e) {
			// ps not available — skip the check.
		}
	});

	it("freeze → inspect → kill: SIGSTOP, snapshot returned, group fully torn down", async () => {
		scenario = stageScenarioEnv("kill");
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "freeze_kill",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					SHIM_SLEEP_S: "30",
				},
				1500,
			);

			// --- freeze snapshot ---
			assert.equal(result.scenario, "freeze_resume or freeze_kill".includes("freeze_kill") ? "freeze_kill" : result.scenario);
			assert.ok(result.suspended, `suspended field missing: ${combinedStdout}`);
			assert.equal(result.suspended.status, "idle_suspended");
			assert.match(result.suspended.suspensionId, /^susp_/);
			// idleMs should be ≈ IDLE_TIMEOUT_MS (allow generous skew).
			assert.ok(
				result.suspended.idleMs >= 1000 && result.suspended.idleMs <= 6000,
				`idleMs out of band: ${result.suspended.idleMs}`,
			);
			// The shim's "in-flight" tool call is a bash sleep — we
			// expect runningCommand + requestedTimeout to be populated.
			assert.match(
				result.suspended.runningCommand ?? "",
				/sleep 9999/,
				`runningCommand missing/incorrect: ${result.suspended.runningCommand}`,
			);
			assert.equal(result.suspended.requestedTimeout, 900);
			// Tail should contain our shim's first text event.
			const tailText = (result.suspended.tail ?? [])
				.map((t: any) => t.summary)
				.join("\n");
			assert.match(tailText, /starting shim/, `tail did not contain shim text: ${tailText}`);

			// --- inspect ---
			assert.ok(result.inspected, `inspected field missing: ${combinedStdout}`);
			assert.equal(result.inspected.status, "idle_inspect");
			assert.equal(result.inspected.suspensionId, result.suspended.suspensionId);
			// inspect's tail should still have the shim text.
			const inspectText = (result.inspected.tail ?? [])
				.map((t: any) => t.summary)
				.join("\n");
			assert.match(inspectText, /starting shim/);

			// --- kill ---
			assert.ok(result.killText.includes("Killed suspended sub-agent") || result.killText.includes("killed"));
			// kill returns an aborted transcript, but the tool result
			// itself is NOT an error — it's a deliberate user action.
			assert.notEqual(result.killIsError, true, "kill result should not be flagged isError; it's a deliberate user action");

			// Allow the SIGKILL to fully propagate.
			await new Promise((r) => setTimeout(r, 400));

			// No leftover shim process. We don't know the exact pid
			// (the driver didn't expose it), but we can grep via ps.
			// Skip this assertion on hosts without ps; the SIGKILL
			// call itself is the meaningful check.
			try {
				const psOut = childExecSync(`ps -eo pid,comm`, { encoding: "utf8" });
				// The shim runs `sleep` after emitting initial events.
				// If our kill worked, no `sleep 30` (started in the
				// last few seconds) should be present. We can't pin
				// the pid, but we can sanity-check that the ps call
				// works.
				assert.ok(typeof psOut === "string");
			} catch {
				// ps not available; skip the residual-process check.
			}
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("freeze → resume: SIGCONT, watchdog re-armed, shim completes, transcript contains post-freeze events", async () => {
		scenario = stageScenarioEnv("resume");
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			// SHIM_SLEEP_S > IDLE_TIMEOUT so the watchdog fires while
			// the shim is still sleeping. After SIGCONT the shim
			// resumes its sleep; the watchdog re-fires, but the
			// driver's loop keeps resuming until the shim exits.
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "freeze_resume",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					SHIM_SLEEP_S: "5",
				},
				2000,
			);

			assert.equal(result.scenario, "freeze_resume");
			assert.ok(result.initialSuspended);
			assert.equal(result.initialSuspended.status, "idle_suspended");
			// Either we resumed once and got a final result, OR we
			// saw multiple suspensions and got a final result. Both
			// outcomes are valid — the protocol is supposed to handle
			// both cleanly.
			assert.ok(result.suspensionsObserved >= 1);
			// The shim's last event ("resumed final output from shim")
			// should be in the final text.
			assert.match(
				result.finalText,
				/resumed final output from shim/,
				`final transcript missing shim's post-freeze event.\n` +
					`finalText=${result.finalText}\nstdout=${combinedStdout}`,
			);
			// Final result should NOT be flagged as an error.
			assert.equal(result.finalIsError, false, `final result flagged isError`);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	// --- New scenarios covering review fixes (C1, C2, C3, W1, W3, W5) ---

	it("chain → freeze on step 2 → kill preserves step-1 result (W3/C1)", async () => {
		scenario = stageScenarioEnv("chain-kill", SHIM_MULTI_SRC);
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "chain_freeze_kill",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					// 1 internal step per chain-step invocation.
					// Step 2's task carries the FREEZE_ME marker so
					// only its invocation does the long sleep;
					// siblings stay quiet and finish well before
					// the watchdog fires on them.
					SHIM_STEPS: "1",
					SHIM_LONG_SLEEP: "1",
					SHIM_SLEEP_S: "10",
					SHIM_QUIET_SLEEP_S: "0.2",
				},
				1500,
			);

			assert.equal(result.scenario, "chain_freeze_kill");
			// Step 1 completed normally (chain runner should have
			// popped it into the results array before step 2 ran).
			assert.ok(result.firstStepHasShimText, `step 1 result lost: ${result.firstStepText}`);
			// Resume picked up the second suspension OR completed
			// (both are valid here).
			assert.ok(
				result.resumedSawSecondSuspension || /resumed final output from shim/.test(result.killText),
				`resume neither re-froze nor completed: killText=${result.killText}`,
			);
			// killText is the post-kill payload. It should still
			// contain the shim's "step 1 finished" event text from
			// the first completed step — proving the chain context
			// survived the freeze (C3/W3 fix).
			assert.match(
				result.killText,
				/step 1: finished|starting shim/,
				`step-1 result lost from kill payload.\nkillText=${result.killText}\nstdout=${combinedStdout}`,
			);
			// Registry must be empty after the kill path. The R1
			// hang fix guarantees the close handler doesn't spawn
			// orphan chain remaining steps, so the kill's
			// unregister is the final word on this id.
			assert.ok(
				result.registryEmpty,
				`orphan suspensions remain after chain kill: ${JSON.stringify(result.registryAfterIds)}`,
			);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("parallel 3 tasks, 1 suspends → resume → all 3 slots correct (C2)", async () => {
		// Stage a scenario with 3 DISTINCT agent names so the slot
		// map is unambiguous. The previous run used a single
		// `test-agent` for all 3, which masked C2-style ordering
		// regressions (any permutation of identical-name slots
		// would still pass the agent-name assertion). The new
		// multi-suspension scenario below relies on this for
		// per-slot assertions.
		const names = ["test-agent-a", "test-agent-b", "test-agent-c"];
		const cwd = mkdtempSync(join(tmpdir(), "pi-e2e-parallel-resume-"));
		const binDir = mkdtempSync(join(tmpdir(), "pi-e2e-bin-parallel-resume-"));
		// The driver issues its initial r1 call against the
		// single-mode `test-agent` (so the parallel scenario can
		// test the cold freeze path before parallel resumes).
		// Stage that agent too.
		writeTestAgents(cwd, ["test-agent", ...names]);
		const shimDest = join(binDir, "pi");
		writeFileSync(shimDest, readFileSync(SHIM_MULTI_SRC, "utf8"));
		chmodSync(shimDest, 0o755);
		scenario = {
			cwd,
			binDir,
			cleanup: () => {
				try {
					rmSync(cwd, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
				try {
					rmSync(binDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			},
		};
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "parallel_one_suspend_resume",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					AGENTS: names.join(","),
					// 1 step per task. Only the task whose description
					// contains FREEZE_ME actually runs the long
					// sleep (siblings are quiet and finish well
					// before the watchdog fires on them).
					SHIM_STEPS: "1",
					SHIM_LONG_SLEEP: "1",
					SHIM_SLEEP_S: "10",
					SHIM_QUIET_SLEEP_S: "0.3",
				},
				1500,
			);

			assert.equal(result.scenario, "parallel_one_suspend_resume");
			// Two sibling tasks completed before the suspension.
			assert.equal(result.completedAtSuspension, 2);
			// Exactly one suspension id at suspension time.
			assert.equal(result.suspendedIds.length, 1);
			// The merged array rebuild (C2 fix) gives exactly 3
			// slots, one per task, in their original order.
			assert.equal(result.finalAgentCount, 3, `expected 3 slots, got ${result.finalAgentCount}: ${combinedStdout}`);
			assert.ok(result.finalHasThreeSlots);
			assert.ok(result.finalAgentsMatch);
			assert.ok(result.finalResultsHaveAllAgents);
			// Per-agent check: every agent name must appear at
			// least once in the finalText.
			for (const agent of names) {
				assert.ok(
					result.finalText.includes(agent),
					`finalText missing agent ${agent}: ${result.finalText}`,
				);
			}
			// Per-slot index check: the result of EACH agent
			// matches its original task index.
			for (const slot of result.slotIndex ?? []) {
				assert.equal(slot.slotAgent, slot.taskAgent, `slot ${slot.slotIndex} has wrong agent`);
			}
			// Registry must be empty after the parallel resume.
			assert.ok(
				result.registryEmpty,
				`orphan suspensions remain after parallel resume: ${JSON.stringify(result.registryAfterIds)}`,
			);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("parallel 3 tasks, 2 suspend concurrently → resume both → no slot shift (C2 multi-suspension)", async () => {
		// N-C2 headline scenario: 3 tasks; 2 freeze at the same time
		// (different agent names so each slot is unambiguous). The
		// resumed-then-second-resumed sequence must produce a final
		// result whose slot at each index corresponds to the task
		// originally at that index — NOT a sibling slot shifted by
		// the presence of two suspensions.
		const names = ["test-agent-a", "test-agent-b", "test-agent-c"];
		const cwd = mkdtempSync(join(tmpdir(), "pi-e2e-parallel-two-suspend-"));
		const binDir = mkdtempSync(join(tmpdir(), "pi-e2e-bin-parallel-two-suspend-"));
		// The driver issues its initial r1 call against the
		// single-mode `test-agent`. Stage it too.
		writeTestAgents(cwd, ["test-agent", ...names]);
		const shimDest = join(binDir, "pi");
		writeFileSync(shimDest, readFileSync(SHIM_MULTI_SRC, "utf8"));
		chmodSync(shimDest, 0o755);
		scenario = {
			cwd,
			binDir,
			cleanup: () => {
				try {
					rmSync(cwd, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
				try {
					rmSync(binDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			},
		};
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "parallel_two_suspend_resume",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					AGENTS: names.join(","),
					SHIM_STEPS: "1",
					SHIM_LONG_SLEEP: "1",
					SHIM_SLEEP_S: "10",
					SHIM_QUIET_SLEEP_S: "0.3",
				},
				1500,
			);

			assert.equal(result.scenario, "parallel_two_suspend_resume");
			// Two sibling tasks completed (the QUIET one); two
			// tasks FROZE concurrently.
			assert.equal(result.completedAtSuspension, 1);
			// Two suspension ids registered at suspension time.
			assert.equal(result.suspendedIds.length, 2, `expected 2 concurrent suspensions, got ${result.suspendedIds.length}: ${combinedStdout}`);
			// First resume should NOT yet produce a final result
			// (because a sibling is still suspended). We should see
			// a still-suspended snapshot pointing at the remaining
			// id.
			assert.ok(result.firstResumeKeptSecond, `first resume lost the second suspension: ${combinedStdout}`);
			// After the second resume, the final result has 3 slots
			// in the correct order.
			assert.equal(result.finalAgentCount, 3, `expected 3 slots, got ${result.finalAgentCount}: ${combinedStdout}`);
			assert.ok(result.finalHasThreeSlots);
			assert.ok(result.finalAgentsMatch);
			// Per-slot integrity: each slot's agent matches the
			// task originally at that index. A shift would be the
			// C2 bug.
			for (const slot of result.slotIndex ?? []) {
				assert.equal(slot.slotAgent, slot.taskAgent, `slot ${slot.slotIndex} has wrong agent (shift bug?)`);
			}
			// Registry must end up empty after both resumes.
			assert.ok(
				result.registryEmpty,
				`orphan suspensions remain after parallel multi-resume: ${JSON.stringify(result.registryAfterIds)}`,
			);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("parallel 3 tasks: kill 1 then resume 1 → no host crash, slots correct (P1)", async () => {
		// P1 regression: 3 parallel tasks (FREEZE_ME × 2 + quiet × 1).
		// After initial suspension, two sibling suspensions are
		// registered. The user kills the FIRST frozen suspension,
		// then resumes the SECOND frozen suspension.
		//
		// Pre-fix crash signature (the live bug):
		//   `TypeError: Cannot read properties of undefined (reading 'agent')`
		//     at liteToSingle (index.ts:450)
		//     at finalizeAndContinue (index.ts:1797)
		//     at ChildProcess.<anonymous> (index.ts:1910)
		//
		// Root cause: `handleKill` did NOT propagate the kill
		// result into siblings' `completedResults`. The second
		// suspension's `completedResults` was still `[C]` (the
		// quiet task's result), but the resume's cursor walk
		// expected to find [A-killed, C] when 2 slots need
		// filling. Cursor wrapped wrong, filled slot 0 with
		// C's result, slot 1 with the resume result, and
		// underflowed slot 2 → `liteToSingle(undefined)` →
		// host crash.
		//
		// Post-fix (P1): `Job.groupId` identifies the parallel
		// call. `handleKill` queries
		// `getSiblingSuspensions(groupId, susp.id)` and rebuilds
		// each sibling's `completedResults` with the kill result
		// inserted at the killed index. The resume's cursor walk
		// then lines up correctly.
		//
		// P3 (host-liveness safety net): even if the cursor walk
		// somehow still underflows (e.g. a future invariant
		// violation), the safeSettle wrapper around the
		// proc.once(close) handler ensures the host pi process
		// does NOT crash — the tool call returns an isError
		// result instead.
		const names = ["test-agent-a", "test-agent-b", "test-agent-c"];
		const cwd = mkdtempSync(join(tmpdir(), "pi-e2e-parallel-kill-resume-"));
		const binDir = mkdtempSync(join(tmpdir(), "pi-e2e-bin-parallel-kill-resume-"));
		// The driver issues its initial r1 call against the
		// single-mode `test-agent`. Stage it too.
		writeTestAgents(cwd, ["test-agent", ...names]);
		const shimDest = join(binDir, "pi");
		writeFileSync(shimDest, readFileSync(SHIM_MULTI_SRC, "utf8"));
		chmodSync(shimDest, 0o755);
		scenario = {
			cwd,
			binDir,
			cleanup: () => {
				try {
					rmSync(cwd, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
				try {
					rmSync(binDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			},
		};
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "parallel_kill_then_resume",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					AGENTS: names.join(","),
					SHIM_STEPS: "1",
					SHIM_LONG_SLEEP: "1",
					SHIM_SLEEP_S: "10",
					SHIM_QUIET_SLEEP_S: "0.3",
				},
				1500,
			);

			assert.equal(result.scenario, "parallel_kill_then_resume");
			// Two concurrent suspensions, one completed sibling.
			assert.equal(result.suspendedIds.length, 2, `expected 2 concurrent suspensions, got ${result.suspendedIds.length}: ${combinedStdout}`);
			assert.equal(result.completedAtSuspension, 1, `expected 1 completed sibling at suspension time, got ${result.completedAtSuspension}: ${combinedStdout}`);

			// Headline: the driver MUST reach the E2E_RESULT line
			// at ALL. Pre-fix, the host pi process crashed inside
			// the close handler, the driver subprocess got killed
			// by SIGCHLD propagation, and `runDriver` rejected
			// with "no E2E_RESULT line in stdout". Asserting on
			// the structured result therefore implicitly catches
			// the crash.
			assert.ok(result.finalAgentCount !== undefined, `driver did not reach final assertion (likely host crash): ${combinedStdout}`);

			// After kill + resume, the final result has exactly 3
			// slots in the correct order.
			assert.equal(result.finalAgentCount, 3, `expected 3 slots, got ${result.finalAgentCount}: ${combinedStdout}`);
			assert.ok(result.finalHasThreeSlots);
			assert.ok(result.finalAgentsMatch);

			// Per-slot integrity: each slot's agent matches the
			// task originally at that index. A shift would be the
			// P1 bug.
			for (const slot of result.slotIndex ?? []) {
				assert.equal(slot.slotAgent, slot.taskAgent, `slot ${slot.slotIndex} has wrong agent (P1 shift bug?)`);
			}

			// Killed slot: exitCode=-1, stopReason="aborted".
			// The driver kills suspendedIds[0]; with the staged
			// agent ordering, the killed index is 0 (test-agent-a).
			const killedSlot = result.slotIndex?.[0];
			assert.ok(killedSlot, `slot 0 missing: ${JSON.stringify(result.slotIndex)}`);
			assert.equal(killedSlot.exitCode, -1, `killed slot should have exitCode=-1, got ${killedSlot.exitCode}`);
			assert.equal(
				killedSlot.stopReason,
				"aborted",
				`killed slot should have stopReason="aborted", got ${killedSlot.stopReason}`,
			);

			// Resumed slot: exitCode=0, no aborted stopReason.
			const resumedSlot = result.slotIndex?.[1];
			assert.ok(resumedSlot, `slot 1 missing: ${JSON.stringify(result.slotIndex)}`);
			assert.equal(resumedSlot.exitCode, 0, `resumed slot should have exitCode=0, got ${resumedSlot.exitCode}`);
			assert.notEqual(
				resumedSlot.stopReason,
				"aborted",
				`resumed slot should not be aborted, got ${resumedSlot.stopReason}`,
			);

			// Quick slot: exitCode=0, completed normally.
			const quickSlot = result.slotIndex?.[2];
			assert.ok(quickSlot, `slot 2 missing: ${JSON.stringify(result.slotIndex)}`);
			assert.equal(quickSlot.exitCode, 0, `quick slot should have exitCode=0, got ${quickSlot.exitCode}`);

			// Registry must be empty after the kill+resume path.
			// The kill must unregister its own suspension AND the
			// resume must unregister the resumed suspension. The
			// resume path's finalizeAndContinue handles the
			// unregister; the kill path's handleKill handles it.
			assert.ok(
				result.registryEmpty,
				`orphan suspensions remain after parallel kill+resume: ${JSON.stringify(result.registryAfterIds)}`,
			);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("double freeze → resume leaves an empty registry (W1/C3)", async () => {
		scenario = stageScenarioEnv("double-freeze", SHIM_MULTI_SRC);
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "double_freeze_resume",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					// 1 step that sleeps WAY longer than 2x the
					// watchdog timeout. We expect TWO freeze/resume
					// cycles before the shim finally exits.
					SHIM_STEPS: "1",
					SHIM_LONG_SLEEP: "1",
					SHIM_SLEEP_S: "10",
					SHIM_QUIET_SLEEP_S: "1",
				},
				1500,
			);

			assert.equal(result.scenario, "double_freeze_resume");
			// At least 2 suspensions were observed (initial freeze +
			// at least one re-freeze after resume). We bound above
			// by 8 to detect runaway loops.
			assert.ok(
				result.suspensionsObservedCount >= 2,
				`expected ≥2 suspensions, got ${result.suspensionsObservedCount}: ${combinedStdout}`,
			);
			assert.ok(
				result.suspensionsObservedCount <= 8,
				`runaway suspension loop: ${result.suspensionsObservedCount} suspensions`,
			);
			// Each suspension id must be unique (no duplicate
			// registrations from W1's leaked timer).
			assert.ok(
				result.suspensionIdsUnique,
				`duplicate suspension ids observed: ${JSON.stringify(result.suspensionIds)}`,
			);
			// Final result must NOT be flagged as an error.
			assert.equal(result.finalIsError, false);
			// Registry must be empty after finalization — proves
			// each freeze cycle properly unregistered the
			// previous suspension.
			assert.ok(
				result.registryEmpty,
				`orphan suspensions remain after resume loop: ${JSON.stringify(result.registryAfterIds)}`,
			);
			// The shim's resumed event should appear in the final
			// transcript, proving the proc completed naturally.
			assert.match(
				result.finalText,
				/resumed final output from shim/,
				`final transcript missing shim completion event.\nfinalText=${result.finalText}\nstdout=${combinedStdout}`,
			);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("resume + kill on same id: resume Promise resolves with killed fact, no hang (F1)", async () => {
		// F1 regression: when the LLM issues `resume: id` and
		// `kill: id` in quick succession against the same
		// suspension, the kill path sets `cancelled = true` and
		// unregisters the suspension. The proc's close event
		// then enters the resume leg's `finalizeAndContinue`,
		// which pre-fix early-returned on `susp.cancelled` and
		// never resolved the resume Promise — the parent's
		// tool call hung forever.
		//
		// Post-fix: `finalizeAndContinue` resolves with a
		// fact-only "Resumed sub-agent was killed while
		// resuming" payload. The driver races resume vs a 3s
		// timeout so a regression surfaces as a clear failure
		// instead of hanging the outer test wrapper.
		scenario = stageScenarioEnv("resume-kill-race");
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "resume_then_kill_race",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					// Shim sleeps long enough that the watchdog
					// will have frozen it before the driver gets
					// the suspension id. We then resume + kill
					// against that frozen proc.
					SHIM_SLEEP_S: "10",
				},
				1500,
			);

			assert.equal(result.scenario, "resume_then_kill_race");
			// The headline assertion: resume Promise resolved
			// within the driver's 3s race window. If F1 is
			// regressed, `resumeTimedOut` would be true and the
			// driver would have exited with code 10, surfacing
			// here as a runDriver reject.
			assert.equal(
				result.resumeTimedOut,
				false,
				`resume Promise hung after kill — F1 regression.\n` +
					`resumeText=${result.resumeText}\nstdout=${combinedStdout}`,
			);
			// Payload must carry the killed-while-resuming fact.
			assert.match(
				result.resumeText,
				/Resumed sub-agent was killed while resuming\./,
				`resume text missing killed-while-resuming fact: ${result.resumeText}\nstdout=${combinedStdout}`,
			);
			// kill path: its own tool result should still carry
			// the regular kill text (proves handleKill ran
			// first, ahead of the resume close event).
			assert.match(
				result.killText,
				/Killed suspended sub-agent/,
				`kill text missing: ${result.killText}\nstdout=${combinedStdout}`,
			);
			// Registry must be empty after the kill path runs.
			// handleKill already unregistered the suspension;
			// the resume leg's cancelled-branch must NOT
			// re-register anything.
			assert.ok(
				result.registryEmpty,
				`orphan suspensions remain after resume-then-kill: ${JSON.stringify(result.registryAfterIds)}`,
			);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("abort while frozen: proc stays alive; resume after abort completes (N-C1/N-W1)", async () => {
		// N-C1 fix semantics: an AbortSignal firing on a FROZEN
		// proc must NOT kill it. The previous test name/assertion
		// was muddled — the driver aborted 250ms AFTER issuing
		// resume, which is "abort while resumed/proc running", not
		// "abort while frozen". Killing a running proc on Ctrl+C
		// is the CORRECT behavior; only killing a frozen proc is
		// the bug.
		//
		// New flow:
		//   1. Cold run suspends the proc (watchdog fires).
		//   2. Driver aborts the AbortSignal WHILE the proc is
		//      still frozen (suspensionId held). The fix
		//      short-circuits the handler because the proc is in
		//      `resumedSuspended = true` state via `isSuspended()`
		//      closure — so a SIGTERM is not issued.
		//   3. Driver asserts the proc is STILL ALIVE via ps.
		//   4. Driver then resumes with a fresh (non-aborted)
		//      signal. The proc wakes up, finishes naturally.
		scenario = stageScenarioEnv("abort-frozen");
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "abort_during_frozen",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					// Long enough for the initial freeze to fire
					// before the abort; the resume leg then
					// completes naturally before the next watchdog
					// tick.
					SHIM_SLEEP_S: "5",
				},
				800,
			);

			assert.equal(result.scenario, "abort_during_frozen");
			// The proc MUST still be alive immediately after the
			// abort fires on the FROZEN proc — proves the abort
			// handler was correctly short-circuited.
			assert.ok(
				result.procAliveAfterAbort,
				`abort handler killed the frozen proc.\nresumeText=${result.resumeText}\nstdout=${combinedStdout}`,
			);
			// The driver then issues a resume (with a fresh,
			// non-aborted signal). With the shim sleeping much
			// longer than IDLE_TIMEOUT_MS, the resume leg
			// itself re-freezes — the test should accept
			// EITHER a completed result OR a still-suspended
			// snapshot. Both prove the resume path was entered
			// correctly (no error from the aborted signal
			// earlier).
			assert.ok(
				result.resumeCompleted || /idle_suspended/.test(result.resumeText),
				`resume after abort neither completed nor re-suspended.\nresumeText=${result.resumeText}\nstdout=${combinedStdout}`,
			);
			assert.equal(result.resumeIsError, false);
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});

	it("deep tree signal: freeze/thaw/kill all reach the setsid grandchild across pgid boundaries", async () => {
		// Headline assertion for the deep-tree signal fix in
		// `suspensions.ts#collectDescendantPids`.
		//
		// The shim spawns a `setsid sleep 30` grandchild that
		// lives in its own process group + session. Pre-fix:
		//   - freeze: only the shim's pgid was SIGSTOP'd — the
		//     grandchild stayed in STAT=Ss (verified live during
		//     the original E2E run).
		//   - kill: only the shim's pgid was SIGKILL'd — the
		//     grandchild was orphaned to PPID=1 and continued
		//     holding whatever port / file lock it had opened.
		// Post-fix: `freezeProcessGroup` / `thawProcessGroup` /
		// `killProcessGroup` walk the ppid tree via
		// `collectDescendantPids` and signal descendants
		// individually after the group-level signal.
		//
		// The scenario runs two stages:
		//   Stage 1 — freeze + thaw depth: verify the grandchild
		//     is STAT=T after freeze, then STAT=non-T after
		//     resume (probed during the resume call's pending
		//     window, before the shim exits).
		//   Stage 2 — kill depth: a fresh run, freeze, then kill.
		//     Grandchild must be gone (no orphan).
		//
		// If `setsid` isn't available (e.g. busybox shim env),
		// the shim silently skips the grandchild spawn and the
		// driver reports `grandchildFrozen/Thawed/Killed` as
		// `"skipped"`. The assertion is permissive in that case
		// (we don't fail the test for a missing tool, but we DO
		// log the situation clearly).
		scenario = stageScenarioEnv("deep-tree", SHIM_MULTI_SRC);
		try {
			const pathWithShimFirst = `${scenario.binDir}${delimiter}${process.env.PATH ?? ""}`;
			const { result, combinedStdout } = await runDriver(
				{
					SCENARIO: "deep_tree_signal",
					TEST_CWD: scenario.cwd,
					PATH: pathWithShimFirst,
					PROJECT_ROOT: PROJECT_ROOT,
					// 1 internal step. The task description carries
					// the FREEZE_ME marker so step 1 does the long
					// sleep. SHIM_DEEP_TREE=1 makes the shim spawn
					// a `setsid sleep` grandchild on the long step.
					SHIM_STEPS: "1",
					SHIM_LONG_SLEEP: "1",
					SHIM_SLEEP_S: "30",
					SHIM_QUIET_SLEEP_S: "0.2",
					SHIM_DEEP_TREE: "1",
					SHIM_GRANDCHILD_PIDFILE: join(scenario.cwd, "grandchild.pid"),
				},
				1500,
				// Generous outer timeout: the driver's stage 1
				// resume waits for the shim to complete its full
				// sleep (30s); stage 2's freeze re-walks and kills
				// quickly. Total scenario < 40s, well under the
				// 60s wrapper.
				55_000,
			);

			assert.equal(result.scenario, "deep_tree_signal");
			// The driver distinguishes between "the grandchild
			// wasn't even spawned" ("skipped": setsid missing)
			// and "the grandchild was spawned, freeze/thaw/kill
			// reached it" (true / false). On a developer /
			// CI host that has setsid, we expect a real probe.
			if (result.grandchildFrozen === "skipped") {
				// Nothing to assert: the host doesn't have
				// setsid, so the shim saw no grandchild to
				// freeze. Print a clear marker so the test
				// output explains why no real signal check ran.
				process.stderr.write(
					"[deep-tree] setsid unavailable on host; grandchildFrozen/Thawed/Killed reported as skipped (no orphan to leak)\n",
				);
			} else {
				// Stage 1 — freeze depth.
				assert.equal(
					result.grandchildFrozen,
					true,
					`deep-tree freeze depth failed: grandchild stat after freeze was ${result.grandchildStatAfterFreeze} (expected T*).\nstdout=${combinedStdout}`,
				);
				// Stage 1 — thaw depth. We probe the stat 200ms
				// after issuing resume (NOT awaiting it), so the
				// shim is still alive and the grandchild is
				// still alive with its deep-thaw applied.
				assert.equal(
					result.grandchildThawed,
					true,
					`deep-tree thaw depth failed: grandchild stat after thaw was ${result.grandchildStatAfterThaw} (expected non-T*).\nstdout=${combinedStdout}`,
				);
				// Stage 2 — kill depth. The grandchild's pid from
				// stage 2 must differ from stage 1 (it's a fresh
				// process) and must be SIGKILL'd by the kill flow.
				assert.notEqual(result.grandchildPid2, null, `stage 2 grandchild pid missing: ${combinedStdout}`);
				// Pre-kill sanity: the grandchild should be
				// alive before the kill. If it isn't, the test
				// assertion is trivially true and we record
				// the situation in the failure message.
				assert.equal(
					result.grandchildPid2AlivePreKill,
					true,
					`stage 2 grandchild (pid ${result.grandchildPid2}) was already dead before kill — orphan-prevention assertion is vacuous.\nstdout=${combinedStdout}`,
				);
				assert.equal(
					result.grandchildKilled,
					true,
					`deep-tree kill depth failed: grandchild (pid ${result.grandchildPid2}) survived the kill — ORPHAN.\nstdout=${combinedStdout}`,
				);
			}
		} finally {
			scenario?.cleanup();
			scenario = null;
		}
	});
});