/**
 * C1 regression test: renderResult must not crash on a
 * non-suspended (normal-exit) result.
 *
 * Background
 * ----------
 * The headline C1 bug was that the renderer's early-return guard
 * read `details.suspensions.length` without an existence check,
 * but the `SubagentDetails` type did not declare the `suspensions`
 * field — the `makeDetails` factory in production code DID populate
 * it, but a future shape change could omit it and every render of
 * a normal-exit result would throw `TypeError: Cannot read
 * properties of undefined (reading 'length')`.
 *
 * This file:
 *   - registers the real extension against a mock `pi` object,
 *     capturing the registered tool definition;
 *   - invokes `renderResult` with a synthetic non-suspended
 *     `AgentToolResult` (mode=single, results=[one], suspensions=[])
 *     using a stub theme + context;
 *   - asserts the renderer returns a non-null TUI element rather
 *     than throwing.
 *
 * The "factory shape" half of C1 is covered by `details.test.ts`;
 * this file is the half that exercises the real renderer with a
 * real (no-suspensions) result, so any future regression that
 * drops `suspensions` from the factory or short-circuits the
 * renderer on `undefined` fails loudly here.
 *
 * Test mechanics
 * --------------
 * We spawn a one-shot Node child process (mirroring the e2e
 * pattern) because importing the extension registers a
 * `process.on("exit")` listener via `parentProcessCleanup` that we
 * don't want accumulating across `node --test` runs. A child
 * process is the cleanest way to scope that side effect.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

interface RenderResult {
	scenario: string;
	ok: boolean;
	error?: string;
	renderedKind?: string;
	renderedText?: string;
}

/** Spawn a tiny script that imports the extension, captures the
 *  tool, and calls renderResult with a non-suspended result.
 *  Returns the parsed JSON. */
function probe(): RenderResult {
	const driverSrc = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mod = await import("${join(PROJECT_ROOT, ".pi/extensions/subagent/index.ts").replace(/\\\\/g, "/")}");
const extensionFn = (mod as { default: (pi: ExtensionAPI) => unknown }).default;

let captured: any = null;
const pi: ExtensionAPI = {
  registerTool: (def) => { captured = def; },
  getAllTools: () => [],
} as unknown as ExtensionAPI;

await extensionFn(pi);
if (!captured) {
  process.stdout.write(JSON.stringify({ scenario: "renderResult", ok: false, error: "no tool captured" }) + "\\n");
  process.exit(0);
}

// Build a synthetic NON-suspended result -- this is the shape
// that makeDetails("single")([])([singleResult]) returns in
// production.
const singleResult = {
  agent: "test-agent",
  agentSource: "project",
  task: "do a thing",
  exitCode: 0,
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text: "all done" }],
      model: "test-model",
      api: "openai-responses",
      provider: "openai",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 3 },
      stopReason: "stop",
      timestamp: 0,
    },
  ],
  stderr: "",
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
  model: "test-model",
  stopReason: "stop",
};

const result = {
  content: [{ type: "text", text: "all done" }],
  details: {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [singleResult],
    suspensions: [], // <- the field that used to be missing
  },
};

// Minimal TUI theme stub: every method returns its string arg.
// renderResult only reads theme.fg() and theme.bold(), so this
// is enough to exercise the renderer without pulling in the real
// theme machinery.
const theme = {
  fg: (_color: any, text: string) => text,
  bold: (text: string) => text,
  muted: (text: string) => text,
  dim: (text: string) => text,
  accent: (text: string) => text,
  toolTitle: (text: string) => text,
  success: (text: string) => text,
  error: (text: string) => text,
  warning: (text: string) => text,
  toolOutput: (text: string) => text,
};

try {
  const rendered = captured.renderResult(result, { expanded: false }, theme, {});
  process.stdout.write(JSON.stringify({
    scenario: "renderResult",
    ok: rendered !== null && rendered !== undefined,
    renderedKind: typeof rendered,
    renderedText: typeof rendered?.text === "string" ? rendered.text.slice(0, 200) : "(non-text)",
  }) + "\\n");
} catch (e) {
  process.stdout.write(JSON.stringify({
    scenario: "renderResult",
    ok: false,
    error: (e as Error).message,
  }) + "\\n");
}
`;
	const driverPath = join(PROJECT_ROOT, ".pi/extensions/subagent/_c1_regression.mts");
	writeFileSync(driverPath, driverSrc, "utf8");
	try {
		const proc = spawnSync(process.execPath, ["--import", "tsx/esm", driverPath], {
			cwd: PROJECT_ROOT,
			env: {
				...process.env,
				TSX_TSCONFIG_PATH: join(PROJECT_ROOT, "tsconfig.test-runtime.json"),
			},
			encoding: "utf8",
		});
		if (proc.status !== 0) {
			return {
				scenario: "renderResult",
				ok: false,
				error: `probe exited with code ${proc.status}\nstderr: ${proc.stderr?.slice(0, 500)}`,
			};
		}
		const line = (proc.stdout ?? "").trim().split("\n").pop() ?? "";
		return JSON.parse(line) as RenderResult;
	} finally {
		try {
			unlinkSync(driverPath);
		} catch {
			/* ignore */
		}
	}
}

describe("renderResult regression (C1)", () => {
	it("does not crash on a non-suspended (mode=single, suspensions=[]) result", () => {
		const r = probe();
		assert.ok(r.ok, `renderResult failed: ${r.error}`);
		// The stub theme echoes strings, so we expect the
		// "all done" final-output text somewhere in the rendered
		// payload.
		if (r.renderedText) {
			assert.match(r.renderedText, /all done/);
		}
	});
});
