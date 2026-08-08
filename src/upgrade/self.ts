import { spawn } from "node:child_process";
import { logger as defaultLogger } from "../lib/logger.js";
import { execCapture as defaultExecCapture, which as defaultWhich, type ExecCaptureResult } from "../lib/env.js";
import type { Logger } from "../lib/plugins/types.js";

/**
 * CLI self-update stage of `pisquad upgrade`.
 *
 * The contract is:
 *
 *   - Honor `--no-self` (CLI flag) or `PISQUAD_NO_SELF=1` (env): when set,
 *     skip the entire stage and report `updated: false`.
 *   - Only attempt an update when the `pisquad` binary on PATH resolves to a
 *     file under npm's global prefix (i.e. was installed via `npm i -g`). When
 *     the binary is missing, or is a non-global install (e.g. `npx pisquad`
 *     sandbox or local dev tree), print "CLI not from global npm, skipping
 *     self-update" and return.
 *   - On a successful `npm install -g pisquad@latest`, return `updated: true`
 *     so the upgrade command can prompt the user to re-run.
 *   - On failure, throw — the upgrade command aborts without touching the
 *     target project.
 *
 * The `deps` hook is for tests only: callers should not pass it in production.
 */

export interface SelfUpdateDeps {
  which?: (cmd: string) => string | null;
  execCapture?: (cmd: string, args?: string[]) => Promise<ExecCaptureResult>;
  /**
   * Override the actual `npm install -g` runner. The default spawns npm with
   * a 2-minute timeout; tests inject a stub that returns a synthetic
   * ExecCaptureResult so no real npm process is ever spawned.
   */
  runNpmInstallGlobal?: () => Promise<ExecCaptureResult>;
}

export interface SelfUpdateOptions {
  logger?: Logger;
  /** Honor the CLI's `--no-self` flag. */
  noSelf?: boolean;
  /** @internal Test seam — override `which` / `execCapture`. */
  deps?: SelfUpdateDeps;
}

export interface SelfUpdateResult {
  updated: boolean;
  /** Human-readable reason for the skip / failure (diagnostic only). */
  reason?: string;
}

const NPM_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — global installs are usually fast
const NPM_GLOBAL_ARGS = ["install", "-g", "pisquad@latest", "--no-audit", "--no-fund"];

/**
 * Spawn `npm install -g pisquad@latest` with a hard timeout.
 *
 * `execCapture` in env.ts does not enforce a timeout, and a stuck global
 * install would otherwise block the whole upgrade command. We use a dedicated
 * spawn here so the timeout is scoped to this stage only.
 */
function runNpmInstallGlobal(): Promise<ExecCaptureResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("npm", NPM_GLOBAL_ARGS, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`failed to spawn npm: ${message}`));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`npm install -g pisquad@latest timed out after ${NPM_TIMEOUT_MS / 1000}s`));
    }, NPM_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Ask npm for the global prefix. New npm exposes `npm prefix -g`; older
 * versions answer the same question via `npm config get prefix`. We try the
 * modern form first and fall back to the legacy one so older Node
 * distributions bundled with older npm still work.
 */
async function getGlobalPrefix(
  execCapture: (cmd: string, args?: string[]) => Promise<ExecCaptureResult>,
): Promise<string | null> {
  const modern = await execCapture("npm", ["prefix", "-g"]);
  if (modern.exitCode === 0) {
    const value = modern.stdout.trim();
    if (value) return value;
  }
  const legacy = await execCapture("npm", ["config", "get", "prefix"]);
  if (legacy.exitCode === 0) {
    const value = legacy.stdout.trim();
    if (value) return value;
  }
  return null;
}

/** Strip trailing slashes and resolve the bin subdir of an npm prefix. */
function globalBinDir(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  return `${trimmed}/bin`;
}

/**
 * True when `child` is at or under `parent`. Both arguments are expected to be
 * absolute, POSIX-style paths. We refuse to match `/foo` against `/foobar`.
 */
function pathStartsWith(child: string, parent: string): boolean {
  if (child === parent) return true;
  if (!child.startsWith(parent)) return false;
  const next = child.charAt(parent.length);
  return next === "/" || next === "";
}

export async function selfUpdate(opts: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  const logger = opts.logger ?? defaultLogger;
  const which = opts.deps?.which ?? defaultWhich;
  const execCapture = opts.deps?.execCapture ?? defaultExecCapture;

  if (opts.noSelf === true || process.env.PISQUAD_NO_SELF === "1") {
    return { updated: false, reason: "--no-self or PISQUAD_NO_SELF=1" };
  }

  const currentPath = which("pisquad");
  if (!currentPath) {
    logger.info("CLI not on PATH, skipping self-update");
    return { updated: false, reason: "pisquad not on PATH" };
  }

  const globalPrefix = await getGlobalPrefix(execCapture);
  if (!globalPrefix) {
    logger.warn("Unable to determine npm global prefix, skipping self-update");
    return { updated: false, reason: "npm prefix detection failed" };
  }

  const binDir = globalBinDir(globalPrefix);
  if (!pathStartsWith(currentPath, binDir)) {
    logger.info("CLI not from global npm, skipping self-update");
    return { updated: false, reason: `not under npm global bin (${binDir})` };
  }

  logger.info(`Updating pisquad via npm install -g (timeout ${NPM_TIMEOUT_MS / 1000}s)`);
  let result: ExecCaptureResult;
  try {
    result = await (opts.deps?.runNpmInstallGlobal ?? runNpmInstallGlobal)();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`self-update failed: ${message}`);
  }

  if (result.exitCode !== 0) {
    const combined = (result.stderr || result.stdout || "").trim();
    const snippet = combined.length > 800 ? `${combined.slice(0, 800)}…` : combined;
    throw new Error(
      `npm install -g pisquad@latest exited ${result.exitCode}${snippet ? `\n${snippet}` : ""}`,
    );
  }

  return { updated: true };
}