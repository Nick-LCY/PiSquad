import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot, resolveAsset, stateFile } from "./paths.js";
import { atomicWriteFile, ensureDir, pathExists } from "./fs-safe.js";
import { readAssetsVersion } from "./assets.js";

/**
 * Install state recorded in <target>/.pi/.pisquad/state.json.
 * Mirrors docs/conventions/install-state.md.
 */
export interface InstallState {
  version: string;
  cliVersion: string;
  channels: {
    core: true;
    codegraph: boolean;
    entire: boolean;
  };
  installedAt: string;
  lastUpgradedAt?: string;
}

export interface WriteStateInput {
  version?: string;
  cliVersion?: string;
  channels: InstallState["channels"];
  installedAt?: string;
  lastUpgradedAt?: string;
}

export type ChannelKey = keyof InstallState["channels"];

/**
 * Raised by `requireState` when `<target>/.pi/.pisquad/state.json` is
 * missing or structurally invalid. The upgrade command catches this and
 * prints the actionable "not installed" message before exiting non-zero
 * (PRD non-goal #1: no migration path for legacy bash-installed projects).
 */
export class StateMissingError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`pisquad: ${target} is not installed, run \`pisquad install\` first`);
    this.name = "StateMissingError";
    this.target = target;
  }
}

export interface VersionDiff {
  /** assets content version differs — payload needs to be re-staged. */
  versionChanged: boolean;
  /** CLI tool version differs — self-update notice (stage-2 task 12) lands here. */
  cliVersionChanged: boolean;
  /** Optional channels newly enabled in this upgrade. */
  newChannels: Array<ChannelKey>;
  /** Optional channels turned off in this upgrade. */
  removedChannels: Array<ChannelKey>;
}

const COMPARABLE_OPTIONAL_CHANNELS: ReadonlyArray<Exclude<ChannelKey, "core">> = [
  "codegraph",
  "entire",
];

/** Read the CLI version embedded in package.json. */
export function readCliVersion(): string {
  const pkgPath = `${resolvePackageRoot()}/package.json`;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch (error) {
    throw new Error(`Unable to read CLI version from ${pkgPath}`, { cause: error });
  }
  throw new Error(`CLI version missing in ${pkgPath}`);
}

/**
 * Resolve the assets content version. Falls back to the CLI version when the
 * assets-version.txt file is not shipped yet (early bootstrap / missing file).
 *
 * Use for display / UX paths only. For state writes, prefer `readAssetsVersion`
 * directly so a missing or unreadable assets-version.txt surfaces as an error
 * rather than being silently papered over.
 */
export function resolveAssetsVersion(fallback: string = readCliVersion()): string {
  try {
    return readAssetsVersion();
  } catch {
    return fallback;
  }
}

/**
 * Strict reader for <target>/.pi/.pisquad/state.json.
 *
 * Returns the parsed state only when every required field has the expected
 * shape (version, cliVersion, installedAt, channels). When the file is
 * missing, unparseable, or structurally invalid, returns undefined so the
 * caller can decide whether to treat the target as not-yet-installed.
 *
 * Note: this function never throws — validation failures map to `undefined`.
 * Upgrade callers should use `requireState` instead, which surfaces the
 * "not installed" condition as a typed `StateMissingError`.
 */
export function readState(target: string): InstallState | undefined {
  const file = stateFile(target);
  if (!pathExists(file)) return undefined;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<InstallState> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.cliVersion !== "string" ||
      typeof parsed.installedAt !== "string" ||
      !parsed.channels ||
      typeof parsed.channels !== "object"
    ) {
      return undefined;
    }
    const channels = parsed.channels as Partial<InstallState["channels"]>;
    if (
      channels.core !== true ||
      typeof channels.codegraph !== "boolean" ||
      typeof channels.entire !== "boolean"
    ) {
      return undefined;
    }
    if (parsed.lastUpgradedAt !== undefined && typeof parsed.lastUpgradedAt !== "string") {
      return undefined;
    }
    return parsed as InstallState;
  } catch {
    return undefined;
  }
}

/**
 * Persist the install state at <target>/.pi/.pisquad/state.json.
 *
 * Rules (see docs/conventions/install-state.md):
 * - `installedAt` is preserved across rewrites once set; first write sets it to now()
 * - `lastUpgradedAt` is preserved when the caller does not provide a new value
 * - `channels.core` is forced to true regardless of caller input
 * - Missing `version` / `cliVersion` are filled from assets + package metadata
 * - Writes are atomic (fs-safe.atomicWriteFile)
 */
export function writeState(target: string, partial: WriteStateInput): InstallState {
  const existing = readState(target);
  const now = new Date().toISOString();
  const cliVersion = partial.cliVersion ?? existing?.cliVersion ?? readCliVersion();
  const version = partial.version ?? existing?.version ?? readAssetsVersion();

  const next: InstallState = {
    version,
    cliVersion,
    channels: {
      core: true,
      codegraph: partial.channels?.codegraph ?? existing?.channels.codegraph ?? false,
      entire: partial.channels?.entire ?? existing?.channels.entire ?? false,
    },
    installedAt: partial.installedAt ?? existing?.installedAt ?? now,
  };

  if (partial.lastUpgradedAt !== undefined) {
    next.lastUpgradedAt = partial.lastUpgradedAt;
  } else if (existing?.lastUpgradedAt !== undefined) {
    next.lastUpgradedAt = existing.lastUpgradedAt;
  }

  const file = stateFile(target);
  ensureDir(`${target}/.pi/.pisquad`);
  // Ensure backups are git-excluded even if the repo-level .gitignore loses
  // the `.pi/.pisquad/` rule (defence in depth: the nested .gitignore makes
  // `backups/` a dead branch under source control regardless of how the
  // outer .gitignore is configured).
  const pisquadGitignore = join(target, ".pi", ".pisquad", ".gitignore");
  if (!existsSync(pisquadGitignore)) {
    atomicWriteFile(pisquadGitignore, "backups/\n");
  }
  atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// Re-export paths helpers used in conjunction with state files.
export { resolveAsset, stateFile };

// Re-export assets reader so upgrade callers can grab both versions from one
// module without reaching into the assets lib directly.
export { readAssetsVersion };

/**
 * Throwing wrapper around `readState` for the upgrade command. A missing or
 * unreadable state file is the documented "old bash install" signal — the
 * upgrader must refuse to run, not silently fall through.
 */
export function requireState(target: string): InstallState {
  const state = readState(target);
  if (!state) throw new StateMissingError(target);
  return state;
}

/**
 * Compare a previously-recorded install state against the version/channels
 * an upgrade is about to apply. Pure — does not touch the filesystem.
 *
 * `core` is intentionally excluded from the channel diff because the schema
 * pins it to `true` on both sides (see `writeState`); comparing it would
 * only ever produce an empty diff.
 */
export function compareVersions(
  prev: InstallState,
  next: { version: string; cliVersion: string; channels: InstallState["channels"] },
): VersionDiff {
  const diff: VersionDiff = {
    versionChanged: prev.version !== next.version,
    cliVersionChanged: prev.cliVersion !== next.cliVersion,
    newChannels: [],
    removedChannels: [],
  };
  for (const key of COMPARABLE_OPTIONAL_CHANNELS) {
    const prevHas = prev.channels[key];
    const nextHas = next.channels[key];
    if (!prevHas && nextHas) diff.newChannels.push(key);
    else if (prevHas && !nextHas) diff.removedChannels.push(key);
  }
  return diff;
}
