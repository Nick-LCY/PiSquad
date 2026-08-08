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

/**
 * Resolve an install target, expanding the conventional ~/ prefix. The result
 * is always absolute.
 *
 * Notes:
 * - Installing to an arbitrary absolute path (including `..`-relative ones
 *   that resolve outside cwd) is intentionally allowed; users routinely ask
 *   pisquad to install into a sibling directory (e.g. `pisquad install ../foo`).
 * - Inputs that look like a typo for `~` but aren't (e.g. `~bob/proj`,
 *   `~user/...`) are NOT shell-expanded — they would silently land in
 *   `./cwd/~bob/proj` instead of bob's home. We log a heads-up so the user can
 *   notice the path is unexpected.
 * - Callers (notably `installCommand`) print the resolved absolute path so
 *   the user always sees the real install destination.
 */
export function resolveTarget(input?: string, cwd = process.cwd()): string {
  const value = input ?? cwd;
  let expanded: string;
  if (value === "~") {
    expanded = homedir();
  } else if (value.startsWith("~/")) {
    expanded = join(homedir(), value.slice(2));
  } else if (value.startsWith("~")) {
    // Looks like a tilde-prefix that we do NOT expand (e.g. "~user/proj").
    // Avoid silent relative-path resolution — warn so the user can react.
    console.warn(`pisquad: target "${value}" starts with "~" but is not "~" or "~/" — leaving it for the shell to expand. Did you mean "~/${value.slice(1)}"?`);
    expanded = value;
  } else {
    expanded = value;
  }
  return resolve(cwd, expanded);
}

/** Return the state file belonging to an install target. */
export function stateFile(target: string): string {
  return join(target, ".pi", ".pisquad", "state.json");
}
