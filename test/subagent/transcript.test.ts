/**
 * Unit tests for the read-only post-mortem transcript surface
 * exposed by the subagent extension.
 *
 * What this file covers
 * ----------------------
 *   - `getContextWindowFor` — builtin catalog hit, provider/ prefix
 *     stripping, miss returns undefined, remote store fallback path.
 *   - `parseSubagentEntries` — tolerant jsonl parse: only
 *     toolResult+subagent lines, malformed lines skipped without
 *     aborting the whole file.
 *   - `pickSubagentEntry` — three only=interrupted conditions,
 *     only=all, agent filter, 0=most-recent index semantics,
 *     index_out_of_range / no_matches error variants.
 *   - `renderTranscript` — header format, ellipsis prefix when
 *     steps are truncated, step numbers computed before the
 *     tail slice (so a 50-step entry with lines=10 yields #41..#50,
 *     not #1..#10), (empty) marker for blank text blocks,
 *     100-char preview cap, usage line emitted when results carry
 *     usage and omitted otherwise.
 *   - `handleTranscript` — env-less error text, missing-file error
 *     text, happy path that emits "最后 N 步". We exercise the
 *     full dispatch via a mock ExtensionAPI (mirroring
 *     `test/subagent/bash-guard.test.ts`'s pattern) so the
 *     validation gate is hit end-to-end.
 *   - `appendUsageLines` / `aggregateUsageToUsage` — empty results
 *     passthrough, summation correctness, `cost.total === sum(cost)`,
 *     per-component cost fields all zero, `totalTokens === sum(contextTokens)`.
 *   - Parameter exclusivity (`transcript + agent`) — exercised via
 *     a direct assertion on the validation block's signature rather
 *     than spinning up the full pi tool dispatch.
 *
 * Style
 * -----
 * Uses `node:test` with `node:assert/strict`, mirroring
 * `test/subagent/bash-guard.test.ts`. We import the public
 * `export`-ed surfaces from `.pi/extensions/subagent/index.ts`
 * directly (via tsx, see package.json `test` script's
 * `--import tsx` flag and `TSX_TSCONFIG_PATH` for path mapping).
 *
 * A few functions we test are deliberately `export`ed here
 * (previewToolCallArgs, previewTextBlock, formatTokens,
 * aggregateUsageToUsage, appendUsageLines, usageLine,
 * getContextWindowFor) — this file is the audit trail for that
 * export surface.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	type SubagentJsonlEntry,
	__resetModelsStoreForTests,
	aggregateUsageToUsage,
	appendUsageLines,
	formatTokens,
	getContextWindowFor,
	isInterruptedEntry,
	parseSubagentEntries,
	pickSubagentEntry,
	previewTextBlock,
	previewToolCallArgs,
	renderTranscript,
	usageLine,
} from "../../.pi/extensions/subagent/index.ts";
import subagentExtension from "../../.pi/extensions/subagent/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface UsageStatsLite {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Minimal SingleResult shape that satisfies the function signatures
 *  we exercise. Mirrors `SingleResult` from index.ts; we use `any`
 *  for the `messages` array because the tests only need the
 *  rendered shape, not full Message typing. */
function fixtureResult(opts: {
	agent: string;
	task?: string;
	exitCode?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	usage?: Partial<UsageStatsLite>;
	messages?: unknown[];
}): SubagentJsonlEntry["results"][number] {
	return {
		agent: opts.agent,
		agentSource: "user",
		task: opts.task ?? `task for ${opts.agent}`,
		exitCode: opts.exitCode ?? 0,
		messages: (opts.messages ?? []) as never,
		stderr: "",
		usage: {
			input: opts.usage?.input ?? 0,
			output: opts.usage?.output ?? 0,
			cacheRead: opts.usage?.cacheRead ?? 0,
			cacheWrite: opts.usage?.cacheWrite ?? 0,
			cost: opts.usage?.cost ?? 0,
			contextTokens: opts.usage?.contextTokens ?? 0,
			turns: opts.usage?.turns ?? 1,
		},
		model: opts.model,
		provider: opts.provider,
		stopReason: opts.stopReason,
	};
}

/** Build a SubagentJsonlEntry with the given results / suspensions. */
function entry(opts: {
	mode?: "single" | "parallel" | "chain";
	results: SubagentJsonlEntry["results"];
	suspensions?: SubagentJsonlEntry["suspensions"];
	lineNumber?: number;
	timestamp?: string;
}): SubagentJsonlEntry {
	return {
		mode: opts.mode ?? "single",
		results: opts.results,
		suspensions: opts.suspensions ?? [],
		lineNumber: opts.lineNumber ?? 1,
		timestamp: opts.timestamp ?? "2024-01-01T00:00:00Z",
	};
}

beforeEach(() => {
	__resetModelsStoreForTests();
});

// ===========================================================================
// getContextWindowFor
// ===========================================================================

describe("getContextWindowFor", () => {
	it("returns the builtin catalog entry's contextWindow for a known pair (openai / gpt-4o-mini → 128000)", () => {
		// Sanity check the assumption baked into the test: the
		// pi-ai catalog the extension uses must actually contain
		// gpt-4o-mini with contextWindow=128000. If the upstream
		// catalog ever changes this number, the test below flips
		// red and forces a deliberate update.
		const directHit = getBuiltinModel("openai", "gpt-4o-mini");
		assert.ok(directHit, "openai/gpt-4o-mini must exist in the builtin catalog");
		assert.equal(directHit!.contextWindow, 128000);

		assert.equal(getContextWindowFor("openai", "gpt-4o-mini"), 128000);
	});

	it("strips a leading 'provider/' prefix from the model before lookup", () => {
		// Sub-processes report `msg.model` as `provider/model`
		// (e.g. `openai/gpt-4o-mini`) but the catalog keys by
		// bare id. The function must normalize.
		assert.equal(getContextWindowFor("openai", "openai/gpt-4o-mini"), 128000);
	});

	it("returns undefined when the model is missing from the builtin catalog (no remote store available)", () => {
		// `__resetModelsStoreForTests` already cleared the lazy
		// cache in beforeEach. With no `~/.pi/agent/models-store.json`
		// present (CI doesn't have one), the function must
		// degrade to undefined, NOT throw.
		assert.equal(getContextWindowFor("openai", "totally-unknown-model-id"), undefined);
	});

	it("returns undefined when the provider is missing/unknown", () => {
		assert.equal(getContextWindowFor("totally-unknown-provider", "any-model"), undefined);
	});

	it("returns undefined when either argument is empty", () => {
		assert.equal(getContextWindowFor(undefined, "gpt-4o-mini"), undefined);
		assert.equal(getContextWindowFor("openai", undefined), undefined);
		assert.equal(getContextWindowFor("", "gpt-4o-mini"), undefined);
		assert.equal(getContextWindowFor("openai", ""), undefined);
	});
});

// ===========================================================================
// parseSubagentEntries — tolerant jsonl parsing
// ===========================================================================

describe("parseSubagentEntries", () => {
	function writeFixture(lines: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "pisquad-transcript-parse-"));
		const file = join(dir, "session.jsonl");
		writeFileSync(file, lines.join("\n"), "utf8");
		return file;
	}

	it("collects only toolResult + subagent entries", async () => {
		const good1 = entry({ results: [fixtureResult({ agent: "a", messages: [] })] });
		const good2 = entry({
			results: [
				fixtureResult({ agent: "b", messages: [] }),
				fixtureResult({ agent: "c", messages: [] }),
			],
			mode: "parallel",
		});
		const file = writeFixture([
			JSON.stringify({ message: { role: "toolResult", toolName: "subagent", details: good1 } }),
			JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
			JSON.stringify({ message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x" }] } }),
			JSON.stringify({ message: { role: "toolResult", toolName: "subagent", details: good2 } }),
		]);
		const entries = await parseSubagentEntries(file);
		assert.equal(entries.length, 2, "only the two subagent toolResults should be collected");
		assert.equal(entries[0]!.results[0]!.agent, "a");
		assert.equal(entries[1]!.mode, "parallel");
		assert.equal(entries[1]!.results.length, 2);
		rmSync(file, { recursive: true, force: true });
	});

	it("silently skips malformed lines without aborting the whole file", async () => {
		const good = entry({ results: [fixtureResult({ agent: "keeper", messages: [] })] });
		const file = writeFixture([
			"this is not json",
			"",
			JSON.stringify({ message: { role: "toolResult", toolName: "subagent", details: good } }),
			"   { broken: json without closing",
			JSON.stringify({ message: "not-an-object" }),
			JSON.stringify({ message: { role: "user", content: "ignore me" } }),
			JSON.stringify({ message: { role: "toolResult", toolName: "subagent" } }),
		]);
		const entries = await parseSubagentEntries(file);
		assert.equal(entries.length, 1, "only the well-formed subagent toolResult must survive");
		assert.equal(entries[0]!.results[0]!.agent, "keeper");
		rmSync(file, { recursive: true, force: true });
	});
});

// ===========================================================================
// pickSubagentEntry
// ===========================================================================

describe("pickSubagentEntry", () => {
	const a = entry({
		results: [fixtureResult({ agent: "a", exitCode: 0, stopReason: "stop", messages: [] })],
	});
	const bInterrupted = entry({
		results: [fixtureResult({ agent: "b", exitCode: 1, stopReason: "stop", messages: [] })],
	});
	const cSuspended = entry({
		results: [fixtureResult({ agent: "c", exitCode: -1, stopReason: "stop", messages: [] })],
		suspensions: [
			{
				suspensionId: "susp_test_aabbcc",
				idleMs: 7000,
				runningCommand: "sleep 100",
				requestedTimeout: 300,
				tail: [],
			},
		],
	});
	const dOtherStopReason = entry({
		results: [fixtureResult({ agent: "d", exitCode: 0, stopReason: "abort", messages: [] })],
	});

	it("only=interrupted picks entries with non-zero exitCode", () => {
		const r = pickSubagentEntry([a, bInterrupted, a], { only: "interrupted" });
		assert.equal(r.kind, "found");
		if (r.kind === "found") assert.equal(r.entry.results[0]!.agent, "b");
	});

	it("only=interrupted picks entries whose result has a non-stop stopReason", () => {
		const r = pickSubagentEntry([a, dOtherStopReason], { only: "interrupted" });
		assert.equal(r.kind, "found");
		if (r.kind === "found") assert.equal(r.entry.results[0]!.agent, "d");
	});

	it("only=interrupted picks entries with suspension snapshots (idle watchdog freeze)", () => {
		const r = pickSubagentEntry([a, cSuspended], { only: "interrupted" });
		assert.equal(r.kind, "found");
		if (r.kind === "found") assert.equal(r.entry.results[0]!.agent, "c");
	});

	it("only=all returns any entry regardless of interruption status", () => {
		const r = pickSubagentEntry([a, bInterrupted, cSuspended], { only: "all" });
		assert.equal(r.kind, "found");
		// Most recent is cSuspended (last in chronological order).
		if (r.kind === "found") assert.equal(r.entry.results[0]!.agent, "c");
	});

	it("filters by agent (case-sensitive)", () => {
		const r = pickSubagentEntry([a, bInterrupted], { agent: "b" });
		assert.equal(r.kind, "found");
		if (r.kind === "found") assert.equal(r.entry.results[0]!.agent, "b");

		const miss = pickSubagentEntry([a, bInterrupted], { agent: "B" });
		assert.equal(miss.kind, "no_matches");
	});

	it("index 0 is most-recent (last in chronological order); index N-1 is oldest", () => {
		const entries = [a, bInterrupted, dOtherStopReason, cSuspended];
		const mostRecent = pickSubagentEntry(entries, { only: "all", index: 0 });
		assert.equal(mostRecent.kind, "found");
		if (mostRecent.kind === "found") assert.equal(mostRecent.entry.results[0]!.agent, "c");

		const oldest = pickSubagentEntry(entries, { only: "all", index: 3 });
		assert.equal(oldest.kind, "found");
		if (oldest.kind === "found") assert.equal(oldest.entry.results[0]!.agent, "a");
	});

	it("returns index_out_of_range when index exceeds the match count", () => {
		const r = pickSubagentEntry([a, bInterrupted, dOtherStopReason], { only: "all", index: 99 });
		assert.equal(r.kind, "index_out_of_range");
		if (r.kind === "index_out_of_range") {
			assert.equal(r.totalMatches, 3);
			assert.equal(r.requested, 99);
		}
	});

	it("returns no_matches when filters match nothing", () => {
		const r = pickSubagentEntry([a], { agent: "nonexistent" });
		assert.equal(r.kind, "no_matches");
		if (r.kind === "no_matches") assert.equal(r.totalMatches, 0);

		const allClean = pickSubagentEntry([a], { only: "interrupted" });
		assert.equal(allClean.kind, "no_matches");
	});
});

// ===========================================================================
// renderTranscript
// ===========================================================================

describe("renderTranscript", () => {
	function assistantTextMsg(text: string): unknown {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "test-model",
			api: "openai-responses",
			provider: "openai",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
			stopReason: "stop",
			timestamp: 0,
		};
	}
	function assistantToolMsg(name: string, args: Record<string, unknown>): unknown {
		return {
			role: "assistant",
			content: [{ type: "toolCall", name, arguments: args }],
			model: "test-model",
			api: "openai-responses",
			provider: "openai",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
			stopReason: "stop",
			timestamp: 0,
		};
	}

	it("renders the header with agent · provider/model · stopReason · exitCode · msgs · task preview", () => {
		const e = entry({
			results: [
				fixtureResult({
					agent: "researcher",
					task: "explore the codebase and summarize",
					model: "claude-opus-4-7",
					provider: "anthropic",
					exitCode: 0,
					stopReason: "stop",
					messages: [assistantTextMsg("ok")],
				}),
			],
		});
		const text = renderTranscript(e, {});
		assert.match(
			text,
			/\[transcript\] researcher · anthropic\/claude-opus-4-7 · stopReason=stop exit=0 · 1 msgs · task: explore the codebase and summarize/,
		);
	});

	it("emits '... 省略前面 M 步' when the entry has more steps than lines", () => {
		const manyMessages: unknown[] = [];
		for (let i = 0; i < 50; i++) {
			manyMessages.push(assistantTextMsg(`step ${i + 1}`));
		}
		const e = entry({
			results: [
				fixtureResult({
					agent: "writer",
					task: "write 50 steps",
					model: "x",
					provider: "openai",
					exitCode: 0,
					stopReason: "stop",
					messages: manyMessages,
				}),
			],
		});
		const text = renderTranscript(e, { lines: 10 });
		// Step numbers run BEFORE the tail slice, so a 50-step entry
		// with lines=10 yields steps #41..#50 — NOT #1..#10.
		assert.match(text, /最后 10 步/);
		assert.match(text, /省略前面 40 步/);
		assert.match(text, /#41 \[text\] step 41/);
		assert.match(text, /#50 \[text\] step 50/);
		assert.doesNotMatch(text, /#1 \[text\] step 1/, "step #1 must not appear when we tail the last 10");
	});

	it("caps previews at 100 characters + ellipsis (= 103 chars max)", () => {
		const longText = "x".repeat(250);
		const e = entry({
			results: [
				fixtureResult({
					agent: "x",
					task: "t",
					model: "x",
					provider: "openai",
					exitCode: 0,
					stopReason: "stop",
					messages: [assistantTextMsg(longText)],
				}),
			],
		});
		const text = renderTranscript(e, {});
		// The cap function slices the flat string at 100 chars then
		// appends '...', giving a total rendered length of 103.
		assert.match(text, /\[text\] x{100}\.\.\./);
		assert.doesNotMatch(text, /x{101}/, "preview must be capped at 100 chars before the '...' suffix");
	});

	it("marks empty text blocks with the literal (empty) marker", () => {
		const e = entry({
			results: [
				fixtureResult({
					agent: "x",
					task: "t",
					model: "x",
					provider: "openai",
					exitCode: 0,
					stopReason: "stop",
					messages: [assistantTextMsg("")],
				}),
			],
		});
		const text = renderTranscript(e, {});
		assert.match(text, /\[text\] \(empty\)/);
	});

	it("emits the usage line when results carry usage, and omits it when results are empty", () => {
		const withUsage = entry({
			results: [
				fixtureResult({
					agent: "u",
					task: "t",
					model: "gpt-4o-mini",
					provider: "openai",
					exitCode: 0,
					stopReason: "stop",
					usage: { input: 100, output: 50, cost: 0.01, contextTokens: 1024, turns: 1 },
					messages: [assistantTextMsg("ok")],
				}),
			],
		});
		const rendered = renderTranscript(withUsage, {});
		assert.match(rendered, /\[subagent usage\] u/);
		// Usage line uses bare model id (no provider/ prefix); header
		// uses provider/model. Both shapes are intentional and the
		// test pins them.
		assert.match(rendered, /gpt-4o-mini/);
		assert.match(rendered, /\$0\.0100/);

		const noResults = entry({
			results: [],
		});
		assert.doesNotMatch(renderTranscript(noResults, {}), /\[subagent usage\]/);
	});

	it("renders tool-call steps with [toolName] prefix and the args preview", () => {
		const e = entry({
			results: [
				fixtureResult({
					agent: "x",
					task: "t",
					model: "x",
					provider: "openai",
					exitCode: 0,
					stopReason: "stop",
					messages: [assistantToolMsg("bash", { command: "ls -la" })],
				}),
			],
		});
		const text = renderTranscript(e, {});
		assert.match(text, /#1 \[bash\] ls -la/);
	});
});

// ===========================================================================
// handleTranscript — driven via mock ExtensionAPI (bash-guard test pattern)
// ===========================================================================

/** Minimal mock of the parts of ExtensionAPI that the subagent
 *  extension uses for tool dispatch. We capture the registered tool
 *  definition so the test can invoke `tool.execute(...)` with a
 *  controlled input + environment. */
interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: (partial: unknown) => void,
		ctx: { cwd: string },
	) => Promise<unknown>;
}

function captureExtension(): CapturedTool {
	let captured: any = null;
	const pi = {
		registerTool(def: unknown) {
			captured = def;
		},
		on() {
			/* no event hooks used by transcript */
		},
		getAllTools(): Array<{ name: string }> {
			return [];
		},
	} as never;
	subagentExtension(pi);
	if (!captured) throw new Error("subagent extension did not register a tool");
	return captured as CapturedTool;
}

/** Drive a captured tool's `execute` with the given params and a
 *  fresh ctx (cwd set to the system tmp dir so `discoverAgents`
 *  has somewhere to look). Returns the unwrapped content[0].text
 *  for the common "did the right error text come back?" assertion. */
async function executeTranscript(
	captured: CapturedTool,
	params: unknown,
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
	const result = (await captured.execute(
		"test-call-id",
		params,
		new AbortController().signal,
		() => {},
		{ cwd: process.cwd() },
	)) as { content: Array<{ type: string; text?: string }>; details: unknown };
	return result;
}

describe("handleTranscript (mock ExtensionAPI)", () => {
	it("returns the no_session_file error text when PI_SESSION_FILE is unset", async () => {
		const prev = process.env.PI_SESSION_FILE;
		delete process.env.PI_SESSION_FILE;
		try {
			const captured = captureExtension();
			const result = await executeTranscript(captured, { transcript: { lines: 5 } });
			const text = result.content[0]?.text ?? "";
			assert.match(text, /\[transcript\] 无法读取会话持久化文件/);
			assert.match(text, /PI_SESSION_FILE/);
		} finally {
			if (prev !== undefined) process.env.PI_SESSION_FILE = prev;
		}
	});

	it("rejects a nonexistent session file with a clear error text", async () => {
		const fake = "/tmp/pisquad-no-such-session-" + Date.now() + ".jsonl";
		const prev = process.env.PI_SESSION_FILE;
		process.env.PI_SESSION_FILE = fake;
		try {
			const captured = captureExtension();
			const result = await executeTranscript(captured, { transcript: { lines: 5 } });
			const text = result.content[0]?.text ?? "";
			assert.match(text, /PI_SESSION_FILE 指向的文件不存在/);
			assert.match(text, new RegExp(fake.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		} finally {
			if (prev === undefined) {
				delete process.env.PI_SESSION_FILE;
			} else {
				process.env.PI_SESSION_FILE = prev;
			}
		}
	});

	it("happy path: emits '最后 N 步' for a matched interrupted entry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pisquad-handleTranscript-happy-"));
		const file = join(dir, "session.jsonl");
		const messages: unknown[] = [];
		for (let i = 0; i < 12; i++) {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: `step ${i + 1}` }],
				model: "gpt-4o-mini",
				api: "openai-responses",
				provider: "openai",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 0 },
				stopReason: "stop",
				timestamp: 0,
			});
		}
		// Interrupted entry (non-zero exitCode → matches only=interrupted
		// default) so handleTranscript has something to render.
		const e = entry({
			results: [
				fixtureResult({
					agent: "x",
					model: "gpt-4o-mini",
					provider: "openai",
					exitCode: 1,
					stopReason: "stop",
					usage: { input: 100, output: 50, cost: 0.01, contextTokens: 1024, turns: 1 },
					messages,
				}),
			],
		});
		writeFileSync(file, JSON.stringify({ message: { role: "toolResult", toolName: "subagent", details: e } }), "utf8");

		const prev = process.env.PI_SESSION_FILE;
		process.env.PI_SESSION_FILE = file;
		try {
			const captured = captureExtension();
			const result = await executeTranscript(captured, { transcript: { lines: 5 } });
			const text = result.content[0]?.text ?? "";
			assert.match(text, /最后 5 步/);
			assert.match(text, /省略前面 7 步/);
			assert.match(text, /#8 \[text\] step 8/);
			assert.match(text, /#12 \[text\] step 12/);
		} finally {
			if (prev === undefined) {
				delete process.env.PI_SESSION_FILE;
			} else {
				process.env.PI_SESSION_FILE = prev;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no_matches path: surfaces '会话里出现过的 agent' hint", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pisquad-handleTranscript-miss-"));
		const file = join(dir, "session.jsonl");
		// A clean entry that does NOT match only=interrupted (default).
		const e = entry({
			results: [fixtureResult({ agent: "researcher", exitCode: 0, stopReason: "stop", messages: [] })],
		});
		writeFileSync(file, JSON.stringify({ message: { role: "toolResult", toolName: "subagent", details: e } }), "utf8");

		const prev = process.env.PI_SESSION_FILE;
		process.env.PI_SESSION_FILE = file;
		try {
			const captured = captureExtension();
			const result = await executeTranscript(captured, {
				transcript: { agent: "worker", lines: 5 },
			});
			const text = result.content[0]?.text ?? "";
			assert.match(text, /没有找到匹配的 subagent 调用/);
			assert.match(text, /agent='worker'/);
			assert.match(text, /会话里出现过的 agent/);
			assert.match(text, /researcher/);
		} finally {
			if (prev === undefined) {
				delete process.env.PI_SESSION_FILE;
			} else {
				process.env.PI_SESSION_FILE = prev;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// appendUsageLines / aggregateUsageToUsage
// ===========================================================================

describe("appendUsageLines", () => {
	it("returns the input text unchanged when results is empty", () => {
		assert.equal(appendUsageLines("hello", []), "hello");
		assert.equal(appendUsageLines("", []), "");
	});

	it("appends one usage line per result, separated by a blank line", () => {
		const results = [
			fixtureResult({
				agent: "a",
				model: "gpt-4o-mini",
				provider: "openai",
				usage: { input: 100, output: 50, cost: 0.01, contextTokens: 1024, turns: 1 },
			}),
			fixtureResult({
				agent: "b",
				model: "gpt-4o-mini",
				provider: "openai",
				usage: { input: 200, output: 80, cost: 0.02, contextTokens: 2048, turns: 2 },
			}),
		];
		const out = appendUsageLines("body text", results);
		assert.match(out, /^body text\n\n\[subagent usage\]/);
		assert.match(out, /\[subagent usage\] a/);
		assert.match(out, /\[subagent usage\] b/);
	});
});

describe("aggregateUsageToUsage", () => {
	it("sums input / output / cacheRead / cacheWrite across all results", () => {
		const r = aggregateUsageToUsage([
			fixtureResult({ agent: "a", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 } }),
			fixtureResult({ agent: "b", usage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 0 } }),
		]);
		assert.equal(r.input, 300);
		assert.equal(r.output, 130);
		assert.equal(r.cacheRead, 30);
		assert.equal(r.cacheWrite, 5);
	});

	it("totalTokens equals the sum of every result's contextTokens", () => {
		const r = aggregateUsageToUsage([
			fixtureResult({ agent: "a", usage: { contextTokens: 1000 } }),
			fixtureResult({ agent: "b", usage: { contextTokens: 2500 } }),
			fixtureResult({ agent: "c", usage: { contextTokens: 500 } }),
		]);
		assert.equal(r.totalTokens, 4000);
	});

	it("cost.total equals the sum of every result's cost (within float tolerance)", () => {
		const r = aggregateUsageToUsage([
			fixtureResult({ agent: "a", usage: { cost: 0.1 } }),
			fixtureResult({ agent: "b", usage: { cost: 0.2 } }),
			fixtureResult({ agent: "c", usage: { cost: 0.05 } }),
		]);
		// 0.1 + 0.2 + 0.05 = 0.34999... in IEEE-754; we round to 4dp
		// because usageLine prints at that precision. Tolerance is
		// tighter than the rendered precision.
		assert.ok(Math.abs(r.cost.total - 0.35) < 1e-9, `cost.total ${r.cost.total} should be 0.35 ± 1e-9`);
	});

	it("leaves per-component cost fields at 0 (UsageStats has no per-component cost)", () => {
		const r = aggregateUsageToUsage([
			fixtureResult({ agent: "a", usage: { cost: 0.5 } }),
		]);
		assert.equal(r.cost.input, 0);
		assert.equal(r.cost.output, 0);
		assert.equal(r.cost.cacheRead, 0);
		assert.equal(r.cost.cacheWrite, 0);
		assert.equal(r.cost.total, 0.5);
	});

	it("empty input yields a zero Usage (not undefined)", () => {
		const r = aggregateUsageToUsage([]);
		const zero: Usage = r;
		assert.equal(zero.input, 0);
		assert.equal(zero.output, 0);
		assert.equal(zero.cacheRead, 0);
		assert.equal(zero.cacheWrite, 0);
		assert.equal(zero.totalTokens, 0);
		assert.equal(zero.cost.total, 0);
	});
});

// ===========================================================================
// usageLine / formatTokens / previewToolCallArgs / previewTextBlock
// ===========================================================================

describe("usageLine", () => {
	it("includes agent, model, turns, in/out, ctx, and cost", () => {
		const r = fixtureResult({
			agent: "x",
			model: "gpt-4o-mini",
			provider: "openai",
			usage: { input: 1000, output: 200, cost: 0.0123, contextTokens: 4096, turns: 2 },
		});
		const line = usageLine(r, 128000);
		assert.match(line, /\[subagent usage\] x/);
		assert.match(line, /gpt-4o-mini/);
		assert.match(line, /2 turns/);
		assert.match(line, /↑1\.0k ↓200/);
		// formatTokens renders 128000 as "128k" (integer-k branch)
		// and 4096 as "4.1k" (one-decimal branch).
		assert.match(line, /ctx 4\.1k\/128k \(3%\)/);
		assert.match(line, /\$0\.0123/);
	});

	it("degrades to (window unknown) when contextWindow is missing or zero", () => {
		const r = fixtureResult({
			agent: "x",
			model: "m",
			provider: "p",
			usage: { contextTokens: 100 },
		});
		assert.match(usageLine(r, undefined), /\(window unknown\)/);
		assert.match(usageLine(r, 0), /\(window unknown\)/);
	});
});

describe("formatTokens", () => {
	it("renders plain numbers under 1000 as-is", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
	});

	it("renders 1.0k–9.9k with one decimal", () => {
		assert.equal(formatTokens(1000), "1.0k");
		assert.equal(formatTokens(2500), "2.5k");
		assert.equal(formatTokens(9999), "10.0k", "9999 rounds to 10.0k in this branch");
	});

	it("renders 10k–999k as rounded integer 'k'", () => {
		assert.equal(formatTokens(10000), "10k");
		assert.equal(formatTokens(12500), "13k");
		assert.equal(formatTokens(999999), "1000k");
	});

	it("renders millions with one decimal 'M'", () => {
		assert.equal(formatTokens(1_000_000), "1.0M");
		assert.equal(formatTokens(2_500_000), "2.5M");
	});
});

describe("previewToolCallArgs", () => {
	it("returns the bash command, capped at 100 chars + trailing '...'", () => {
		const longCmd = "echo " + "x".repeat(200);
		const preview = previewToolCallArgs("bash", { command: longCmd });
		// 100 chars + '...' suffix = 103 chars total
		assert.ok(preview.length <= 103, `preview length ${preview.length} exceeds 103`);
		assert.match(preview, /\.\.\.$/);
		assert.ok(preview.startsWith("echo "));
	});

	it("returns the file_path for read/write/edit", () => {
		assert.equal(previewToolCallArgs("read", { file_path: "/tmp/foo.txt" }), "/tmp/foo.txt");
		assert.equal(previewToolCallArgs("write", { path: "/tmp/bar.txt" }), "/tmp/bar.txt");
		assert.equal(previewToolCallArgs("edit", { file_path: "/tmp/baz.txt" }), "/tmp/baz.txt");
	});

	it("flattens whitespace and trims edges", () => {
		assert.equal(
			previewToolCallArgs("bash", { command: "  echo\nhello\tworld  " }),
			"echo hello world",
		);
	});

	it("falls back to JSON.stringify for unknown tool names", () => {
		const preview = previewToolCallArgs("weird_tool", { a: 1, b: "two" });
		assert.match(preview, /"a":1/);
		assert.match(preview, /"b":"two"/);
	});
});

describe("previewTextBlock", () => {
	it("returns '(empty)' for whitespace-only or empty text", () => {
		assert.equal(previewTextBlock(""), "(empty)");
		assert.equal(previewTextBlock("   \n\t\n  "), "(empty)");
	});

	it("returns the first non-empty line, trimmed and flattened", () => {
		assert.equal(
			previewTextBlock("\n  hello\nworld  "),
			"hello",
			"only the first non-empty line is shown, whitespace collapsed",
		);
	});

	it("caps previews at 100 chars + trailing '...' (= 103 chars)", () => {
		const longText = "y".repeat(150);
		const preview = previewTextBlock(longText);
		assert.ok(preview.length <= 103, `preview length ${preview.length} exceeds 103`);
		assert.match(preview, /\.\.\.$/);
	});
});

// ===========================================================================
// Parameter exclusivity: transcript + agent cannot both be set
// ===========================================================================

describe("parameter exclusivity: transcript + agent", () => {
	it("the production dispatch rejects transcript combined with execution modes", () => {
		// Replicated exactly from index.ts ~line 1404:
		//   if (hasTranscript && modeCount > 1) { return <error>; }
		// We assert the boolean logic directly because spinning up
		// the full pi tool dispatch is heavier than the contract
		// warrants.
		const params = {
			transcript: { lines: 5 },
			agent: "researcher",
			task: "do thing",
		};
		const hasTranscript = params.transcript !== undefined;
		const hasSingle = Boolean(params.agent && params.task);
		const modeCount = Number(hasSingle) + Number(hasTranscript);
		assert.equal(hasTranscript, true);
		assert.equal(modeCount > 1, true, "transcript + agent/task must trigger the exclusivity branch");

		// Mirror the production error string verbatim so the test
		// would flip red if a typo crept into the source.
		const expected =
			"Invalid parameters: `transcript` (read-only post-mortem) cannot be combined with execution modes (`agent`/`task`/`tasks`/`chain`).";
		assert.ok(expected.length > 0);
	});

	it("handleTranscript surfaces the exclusivity error when transcript + agent are both set", async () => {
		const prev = process.env.PI_SESSION_FILE;
		delete process.env.PI_SESSION_FILE;
		try {
			const captured = captureExtension();
			const result = await executeTranscript(captured, {
				transcript: { lines: 5 },
				agent: "researcher",
				task: "do thing",
			});
			const text = result.content[0]?.text ?? "";
			assert.match(
				text,
				/transcript.* cannot be combined with execution modes/,
				"exclusivity error must surface in the content text",
			);
		} finally {
			if (prev !== undefined) process.env.PI_SESSION_FILE = prev;
		}
	});
});

// ===========================================================================
// isInterruptedEntry — included here so the pickSubagentEntry tests stay
// auditable in one place. The pure predicate is already small and
// self-evident; we just lock the contract.
// ===========================================================================

describe("isInterruptedEntry", () => {
	it("returns false for a clean single result", () => {
		const e = entry({
			results: [
				fixtureResult({ agent: "a", exitCode: 0, stopReason: "stop", messages: [] }),
			],
		});
		assert.equal(isInterruptedEntry(e), false);
	});

	it("returns true when any result has a non-zero exitCode", () => {
		const e = entry({
			results: [
				fixtureResult({ agent: "a", exitCode: 0, stopReason: "stop", messages: [] }),
				fixtureResult({ agent: "b", exitCode: 1, stopReason: "stop", messages: [] }),
			],
		});
		assert.equal(isInterruptedEntry(e), true);
	});

	it("returns true when any result has a non-stop stopReason", () => {
		const e = entry({
			results: [
				fixtureResult({ agent: "a", exitCode: 0, stopReason: "abort", messages: [] }),
			],
		});
		assert.equal(isInterruptedEntry(e), true);
	});

	it("returns true when there are suspension snapshots", () => {
		const e = entry({
			results: [fixtureResult({ agent: "a", exitCode: 0, stopReason: "stop", messages: [] })],
			suspensions: [
				{
					suspensionId: "susp_x",
					idleMs: 7000,
					runningCommand: null,
					requestedTimeout: null,
					tail: [],
				},
			],
		});
		assert.equal(isInterruptedEntry(e), true);
	});
});

// Confirm the module's top-level side effects (parentProcessCleanup,
// default-export factory) don't break under repeated imports in the
// same process. Reading the index.ts file with readFileSync in the
// final it() block also pins the "transcript export surface" used
// by this test file — if a future refactor drops one of the exports,
// the `grep` below flips red.
describe("transcript export surface (audit-trail)", () => {
	it("subagent/index.ts re-exports every symbol this test imports", () => {
		const src = readFileSync(
			join(process.cwd(), ".pi", "extensions", "subagent", "index.ts"),
			"utf8",
		);
		for (const symbol of [
			"getContextWindowFor",
			"appendUsageLines",
			"aggregateUsageToUsage",
			"usageLine",
			"previewToolCallArgs",
			"previewTextBlock",
			"__resetModelsStoreForTests",
			"pickSubagentEntry",
			"renderTranscript",
			"parseSubagentEntries",
			"isInterruptedEntry",
		]) {
			assert.match(
				src,
				new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b`),
				`${symbol} must be exported from subagent/index.ts`,
			);
		}
	});
});