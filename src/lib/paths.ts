import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** Locate the package root from either dist/ or the TypeScript source tree. */
export function resolvePackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Unable to locate pisquad package root from ${import.meta.url}`);
}

/** Resolve a path relative to the assets embedded in this package. */
export function resolveAsset(rel: string): string {
  return join(resolvePackageRoot(), "assets", rel);
}

/** Resolve an install target, expanding the conventional ~/ prefix. */
export function resolveTarget(input?: string, cwd = process.cwd()): string {
  const value = input ?? cwd;
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return resolve(cwd, expanded);
}

/** Return the state file belonging to an install target. */
export function stateFile(target: string): string {
  return join(target, ".pi", ".pisquad", "state.json");
}
