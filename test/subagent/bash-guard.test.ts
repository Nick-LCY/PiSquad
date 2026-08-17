/**
 * Unit tests for the bash-guard extension's two surfaces:
 *
 *   1. **tool_call**: injects the default timeout (and tracks the call
 *      id) iff the caller left `input.timeout` undefined / null.
 *
 *   2. **tool_result**: appends a factual hint to `content` iff all
 *      four gates pass — bash tool, id was tracked, isError, content
 *      mentions a timeout. The tracking entry is always drained so the
 *      Map can never leak across tool calls.
 *
 * We do NOT spin up a real pi host. Instead we mock `ExtensionAPI`
 * with just enough surface (`on`) to capture the registered handlers,
 * then invoke them with synthetic events. This lets us cover the
 * behavior without the test process registering real extensions or
 * shelling out.
 *
 * Coverage matrix:
 *
 *   | input.timeout | isError | content mentions timeout | hint appended? |
 *   |---------------|---------|--------------------------|----------------|
 *   | undefined     | true    | yes (e.g. "timed out")   | YES            |
 *   | undefined     | true    | no (e.g. exit code != 0) | no             |
 *   | undefined     | false   | (n/a — success)          | no             |
 *   | explicit      | true    | yes                      | no (didn't inject)
 *   | null          | true    | yes                      | YES (null is "absent")
 *   | 0             | true    | yes                      | no (0 = explicit choice)
 *
 * Plus:
 *   - Map cleanup: tool_call that injected, then tool_result → map size 0
 *   - Env override (`BASH_GUARD_DEFAULT_TIMEOUT_S`): value appears in
 *     both the injection AND the hint text. We verify by calling the
 *     default export under a fake env, not by mutating `process.env`
 *     (which would be test-order-dependent).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import bashGuard, {
	__getTrackedDefaultInjectionCountForTests,
	buildBashGuardHint,
	resolveDefaultTimeoutS,
} from "../../.pi/extensions/bash-guard/index.ts";

/** Minimal mock of the parts of ExtensionAPI that bash-guard uses. */
interface MockPi {
	on(event: string, handler: (...args: unknown[]) => unknown): void;
}

function makeMockPi(): {
	pi: MockPi;
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
} {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi: MockPi = {
		on(event, handler) {
			const bucket = handlers.get(event) ?? [];
			bucket.push(handler);
			handlers.set(event, bucket);
		},
	};
	return { pi, handlers };
}

/** Build a synthetic bash tool_call event. */
function bashToolCall(toolCallId: string, input: { command: string; timeout?: number | null }): {
	type: "tool_call";
	toolName: "bash";
	toolCallId: string;
	input: { command: string; timeout?: number | null };
} {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId,
		input,
	};
}

/** Build a synthetic bash tool_result event with optional error semantics. */
function bashToolResult(
	toolCallId: string,
	content: Array<{ type: "text"; text: string }>,
	isError: boolean,
): {
	type: "tool_result";
	toolName: "bash";
	toolCallId: string;
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: undefined;
	usage: undefined;
} {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		content,
		isError,
		details: undefined,
		usage: undefined,
	};
}

/** Convenience: pull the captured tool_call handler and run it. */
async function runToolCall(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	event: ReturnType<typeof bashToolCall>,
): Promise<void> {
	const bucket = handlers.get("tool_call");
	assert.ok(bucket && bucket.length === 1, "expected exactly one tool_call handler to be registered");
	await bucket![0]!(event);
}

/** Convenience: pull the captured tool_result handler and run it. */
async function runToolResult(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	event: ReturnType<typeof bashToolResult>,
): Promise<unknown> {
	const bucket = handlers.get("tool_result");
	assert.ok(bucket && bucket.length === 1, "expected exactly one tool_result handler to be registered");
	return await bucket![0]!(event);
}

describe("bash-guard tool_call: default timeout injection", () => {
	it("injects the default when timeout is undefined and tracks the call id", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		const event = bashToolCall("call-undef-1", { command: "sleep 10" });
		await runToolCall(handlers, event);
		assert.equal(event.input.timeout, 300, "undefined timeout should be replaced with 300");
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 1, "exactly one tracked call");
		// Drain the map so this test does not leak into siblings.
		await runToolResult(handlers, bashToolResult("call-undef-1", [], false));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0);
	});

	it("injects the default when timeout is null and tracks the call id", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		const event = bashToolCall("call-null-1", { command: "sleep 10", timeout: null });
		await runToolCall(handlers, event);
		assert.equal(event.input.timeout, 300, "null timeout should be replaced with 300");
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 1);
		await runToolResult(handlers, bashToolResult("call-null-1", [], false));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0);
	});

	it("does NOT inject when the caller passed a positive timeout (explicit choice)", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		const event = bashToolCall("call-explicit-1", { command: "sleep 10", timeout: 900 });
		await runToolCall(handlers, event);
		assert.equal(event.input.timeout, 900, "explicit timeout must be preserved verbatim");
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0, "explicit-timeout calls are not tracked");
	});

	it("does NOT inject when the caller passed 0 (explicit 'wait forever')", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		const event = bashToolCall("call-zero-1", { command: "sleep 10", timeout: 0 });
		await runToolCall(handlers, event);
		assert.equal(event.input.timeout, 0, "0 must be preserved as an explicit opt-in");
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0);
	});

	it("leaves non-bash tool_calls alone and does not track them", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		const bucket = handlers.get("tool_call");
		assert.ok(bucket);
		// Build a non-bash event — the production narrowing is
		// `isToolCallEventType("bash", event)` which at runtime
		// just checks `event.toolName === toolName`.
		const otherEvent = {
			type: "tool_call" as const,
			toolName: "read",
			toolCallId: "call-read-1",
			input: { file_path: "/tmp/x" },
		};
		await bucket![0]!(otherEvent);
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0, "read must not be tracked");
	});
});

describe("bash-guard tool_result: timeout hint (teachable moment)", () => {
	it("appends the hint when all four gates pass (default-injected + isError + content mentions timeout)", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		// Pair: inject, then surface a timeout error.
		await runToolCall(handlers, bashToolCall("call-hint-1", { command: "sleep 999" }));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 1);

		const result = await runToolResult(
			handlers,
			bashToolResult(
				"call-hint-1",
				[{ type: "text", text: "Command timed out after 300 seconds\n\n<process exited>" }],
				true,
			),
		) as { content: Array<{ type: string; text?: string }> } | undefined;

		assert.ok(result, "handler should return a partial patch when all gates pass");
		assert.ok(Array.isArray(result!.content), "patch must include content");
		const lastPart = result!.content[result!.content.length - 1];
		assert.equal(lastPart.type, "text");
		assert.match(
			lastPart.text!,
			/bash-guard: no explicit timeout was passed, so the default 300s was applied/,
			"hint should appear as the final text part",
		);
		assert.match(
			lastPart.text!,
			/Pass a "timeout" parameter \(seconds\) for commands that legitimately need longer/,
		);
		// Map must be drained regardless of whether we returned a patch.
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0, "tool_result must drain the map");
	});

	it("does NOT append the hint when the caller passed an explicit timeout (even if the error mentions timeout)", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		// Explicit 900s timeout → no injection → not tracked.
		await runToolCall(handlers, bashToolCall("call-explicit-hint-1", { command: "sleep 999", timeout: 900 }));
		const result = await runToolResult(
			handlers,
			bashToolResult(
				"call-explicit-hint-1",
				[{ type: "text", text: "Command timed out after 900 seconds" }],
				true,
			),
		);
		assert.equal(result, undefined, "explicit-timeout errors must not be augmented");
	});

	it("does NOT append the hint when isError=true but the content does not mention a timeout", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		await runToolCall(handlers, bashToolCall("call-non-timeout-err-1", { command: "false" }));
		const result = await runToolResult(
			handlers,
			bashToolResult(
				"call-non-timeout-err-1",
				[{ type: "text", text: "Command exited with code 1\n\n<process exited>" }],
				true,
			),
		);
		assert.equal(result, undefined, "non-timeout errors must not be mis-attributed to bash-guard");
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0, "map still drained");
	});

	it("does NOT append the hint when isError=false (successes never time out)", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		await runToolCall(handlers, bashToolCall("call-success-1", { command: "echo hi" }));
		const result = await runToolResult(
			handlers,
			bashToolResult("call-success-1", [{ type: "text", text: "hi" }], false),
		);
		assert.equal(result, undefined, "successes must not be augmented");
	});

	it("recognizes 'timeout' (single word) and 'timed-out' (hyphenated) as well as 'timed out'", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		const variants = [
			"Request timeout while reading from upstream",
			"Connection timed-out after retries",
			"Operation timed out unexpectedly",
		];
		for (const [i, text] of variants.entries()) {
			const id = `call-variant-${i}`;
			await runToolCall(handlers, bashToolCall(id, { command: "x" }));
			const result = (await runToolResult(
				handlers,
				bashToolResult(id, [{ type: "text", text }], true),
			)) as { content: Array<{ type: string; text?: string }> } | undefined;
			assert.ok(result, `variant "${text}" should trigger a hint`);
			const last = result!.content[result!.content.length - 1];
			assert.equal(last.type, "text");
			assert.match(last.text!, /bash-guard: no explicit timeout was passed/);
		}
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0);
	});

	it("partial patch on tool_result leaves isError / details / usage out of the patch object", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		await runToolCall(handlers, bashToolCall("call-patch-shape-1", { command: "sleep 999" }));
		const result = (await runToolResult(
			handlers,
			bashToolResult(
				"call-patch-shape-1",
				[{ type: "text", text: "Command timed out after 300 seconds" }],
				true,
			),
		)) as Record<string, unknown>;
		// Per the partial-patch contract, the patch should NOT contain
		// isError / details / usage keys; only the keys we actually
		// want to mutate (here: `content`).
		assert.ok("content" in result, "content key must be in the patch");
		assert.ok(!("isError" in result), "isError must NOT be in the patch");
		assert.ok(!("details" in result), "details must NOT be in the patch");
		assert.ok(!("usage" in result), "usage must NOT be in the patch");
	});

	it("drains the tracking map on tool_result even when no patch is returned", async () => {
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		await runToolCall(handlers, bashToolCall("call-drain-1", { command: "echo hi" }));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 1);
		// Force a non-teaching branch (success) — the map must still drain.
		await runToolResult(handlers, bashToolResult("call-drain-1", [{ type: "text", text: "hi" }], false));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0, "tool_result must drain regardless of branch");
	});

	it("drains the tracking map for an unknown toolCallId (idempotent no-op delete)", async () => {
		// If for some reason a tool_result arrives without a prior
		// tool_call (out-of-order, replay, etc.), the delete must
		// simply be a no-op and the existing map must stay untouched.
		const { pi, handlers } = makeMockPi();
		bashGuard(pi);
		await runToolCall(handlers, bashToolCall("call-orphan-A", { command: "echo hi" }));
		await runToolCall(handlers, bashToolCall("call-orphan-B", { command: "echo hi" }));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 2);
		// Drain an id that was never tracked.
		await runToolResult(
			handlers,
			bashToolResult("call-orphan-NEVER", [{ type: "text", text: "phantom" }], true),
		);
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 2, "orphaned tool_result must not affect tracked entries");
		// Drain the real ones to keep the suite clean.
		await runToolResult(handlers, bashToolResult("call-orphan-A", [{ type: "text", text: "hi" }], false));
		await runToolResult(handlers, bashToolResult("call-orphan-B", [{ type: "text", text: "hi" }], false));
		assert.equal(__getTrackedDefaultInjectionCountForTests(), 0);
	});
});

describe("bash-guard env override (BASH_GUARD_DEFAULT_TIMEOUT_S)", () => {
	/** Re-import the default export with a controlled env to assert that
	 *  the injected value AND the hint text both reflect the override. */
	async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
		const original = process.env.BASH_GUARD_DEFAULT_TIMEOUT_S;
		try {
			if (env.BASH_GUARD_DEFAULT_TIMEOUT_S === undefined) {
				delete process.env.BASH_GUARD_DEFAULT_TIMEOUT_S;
			} else {
				process.env.BASH_GUARD_DEFAULT_TIMEOUT_S = env.BASH_GUARD_DEFAULT_TIMEOUT_S;
			}
			// AWAIT the inner fn — otherwise the `finally` below would
			// reset the env synchronously *before* any awaited work in
			// `fn` (e.g. `bashGuard(pi)`'s env read) actually observes it.
			return await fn();
		} finally {
			if (original === undefined) {
				delete process.env.BASH_GUARD_DEFAULT_TIMEOUT_S;
			} else {
				process.env.BASH_GUARD_DEFAULT_TIMEOUT_S = original;
			}
		}
	}

	it("applies a positive integer env override to the injected default", async () => {
		await withEnv({ BASH_GUARD_DEFAULT_TIMEOUT_S: "42" }, async () => {
			const { pi, handlers } = makeMockPi();
			bashGuard(pi);
			const event = bashToolCall("call-env-42-1", { command: "sleep 5" });
			await runToolCall(handlers, event);
			assert.equal(event.input.timeout, 42, "env override must be the injected value");
			// The hint delivered via the tool_result patch must also
			// mention 42 (the closure-bound `hintText` inside bashGuard
			// is captured at extension-register time, so this exercises
			// that the env is read then — not just when we manually
			// build the hint below).
			const patch = (await runToolResult(
				handlers,
				bashToolResult(
					"call-env-42-1",
					[{ type: "text", text: "Command timed out after 42 seconds" }],
					true,
				),
			)) as { content: Array<{ type: string; text?: string }> } | undefined;
			assert.ok(patch, "patch must be returned");
			const last = patch!.content[patch!.content.length - 1];
			assert.match(last.text!, /default 42s was applied/);
			// And resolveDefaultTimeoutS() called *now* (still inside the
			// withEnv scope) must agree with the closure-bound value.
			const hint = buildBashGuardHint(resolveDefaultTimeoutS());
			assert.match(hint, /default 42s was applied/);
		});
	});

	it("applies a fractional env override to both injection and hint", async () => {
		await withEnv({ BASH_GUARD_DEFAULT_TIMEOUT_S: "1.5" }, async () => {
			const { pi, handlers } = makeMockPi();
			bashGuard(pi);
			const event = bashToolCall("call-env-frac-1", { command: "sleep 5" });
			await runToolCall(handlers, event);
			assert.equal(event.input.timeout, 1.5, "fractional override must be honored");
			const hint = buildBashGuardHint(resolveDefaultTimeoutS());
			assert.match(hint, /default 1\.5s was applied/);
		});
	});

	it("ignores illegal env values (falls back to 300) without poisoning the agent", async () => {
		for (const bad of ["abc", "0", "-5", "", "1e1000"]) {
			await withEnv({ BASH_GUARD_DEFAULT_TIMEOUT_S: bad }, async () => {
				const { pi, handlers } = makeMockPi();
				bashGuard(pi);
				const event = bashToolCall(`call-bad-${bad}`, { command: "x" });
				await runToolCall(handlers, event);
				assert.equal(
					event.input.timeout,
					300,
					`illegal env value ${JSON.stringify(bad)} must fall back to 300`,
				);
			});
		}
	});
});

describe("bash-guard buildBashGuardHint (pure)", () => {
	it("renders the factual hint with the supplied default", () => {
		const hint = buildBashGuardHint(120);
		assert.equal(
			hint,
			'bash-guard: no explicit timeout was passed, so the default 120s was applied. Pass a "timeout" parameter (seconds) for commands that legitimately need longer.',
		);
	});

	it("interpolates fractional seconds verbatim", () => {
		const hint = buildBashGuardHint(0.5);
		assert.match(hint, /default 0\.5s was applied/);
	});
});

// Defensive: ensure we register the handlers BEFORE tests run so the
// tracking map cannot be polluted by sibling imports — `before` runs
// after describe registration but before tests in this file.
before(() => {
	// Sanity: the tracking map starts empty for this file. Any
	// previous test that left entries would mean a leak in production,
	// so we fail loud here rather than silently letting later
	// tests' count assertions ride on stale state.
	assert.equal(
		__getTrackedDefaultInjectionCountForTests(),
		0,
		"tracking map must be empty at the start of bash-guard.test.ts (no leaked entries from prior runs)",
	);
});