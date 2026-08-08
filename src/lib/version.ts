import { readFileSync } from "node:fs";
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
 */
export function resolveAssetsVersion(fallback: string = readCliVersion()): string {
  try {
    return readAssetsVersion();
  } catch {
    return fallback;
  }
}

/** Read an existing state file; returns undefined when not present or invalid. */
function readExistingState(target: string): InstallState | undefined {
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
  const existing = readExistingState(target);
  const now = new Date().toISOString();
  const cliVersion = partial.cliVersion ?? existing?.cliVersion ?? readCliVersion();
  const version = partial.version ?? existing?.version ?? resolveAssetsVersion(cliVersion);

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
  atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// Re-export paths helpers used in conjunction with state files.
export { resolveAsset, stateFile };
