import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveAsset } from "./paths.js";

/** Map of relative path (POSIX-style, forward slashes) → lowercase hex sha256. */
export interface FileHashMap {
  [relPath: string]: string;
}

export interface Sha256DirOptions {
  /** Return true to skip a relative path. Applied recursively inside the tree. */
  ignore?: (relPath: string) => boolean;
}

/**
 * Pair one subtree inside the pisquad package with the matching subtree inside
 * the install target. The two subtrees are walked independently and their
 * relative paths are merged into one logical tree for diffing.
 *
 * IMPORTANT: the caller MUST include the `docs` subtree
 * (`{ pkgSubPath: "docs", targetSubPath: "docs" }`) — see PRD §6 "upgrade 安
 * 全机制": docs is the most frequently consumer-edited area and must be
 * diffed alongside `.pi` so the upgrader can detect user modifications and
 * back them up.
 */
export interface PkgInclude {
  /** Subtree under the package's `assets/` directory, e.g. ".pi" or "docs". */
  pkgSubPath: string;
  /** Matching subtree inside the install target, e.g. ".pi" or "docs". */
  targetSubPath: string;
}

export interface DiffTreeOptions {
  /** Skip a relative path on BOTH sides. Defaults to `defaultIgnore`. */
  ignore?: (relPath: string) => boolean;
  /**
   * Override the directory pkg subpaths are resolved against. Defaults to
   * `resolveAsset` (i.e. `<package root>/assets`). Tests use this to point at
   * a synthetic assets tree without mutating the shipped assets.
   */
  assetsRoot?: string;
}

export interface DiffPlan {
  /** Present in both, hash differs — back up then overwrite. */
  modified: Array<{ relPath: string; fromHash: string; toHash: string }>;
  /** Only in pkg — copy into target (no backup needed). */
  added: Array<{ relPath: string; toHash: string }>;
  /** Only in target — kept by default; only deleted when `--prune` is passed. */
  removed: Array<{ relPath: string; fromHash: string }>;
  /** Present in both, same hash — informational. */
  unchanged: Array<{ relPath: string }>;
}

/**
 * Runtime / tool-generated entries that do not count as "user modifications"
 * and are therefore excluded from the diff on both sides:
 *
 * - `node_modules/` — restored by `npm install` after every channel copy
 * - `.pisquad/` — pisquad's own state.json + backups
 * - `.codegraph/` — codegraph CLI's tool-generated cache
 * - `.entire/` — entire CLI's tool-generated metadata
 * - `.DS_Store` — macOS Finder debris
 */
export const DEFAULT_IGNORE_NAMES = new Set([
  "node_modules",
  ".pisquad",
  ".codegraph",
  ".entire",
  ".DS_Store",
]);

/** Default ignore predicate: true for any path whose any segment is in DEFAULT_IGNORE_NAMES. */
export function defaultIgnore(relPath: string): boolean {
  return relPath.split("/").some((segment) => DEFAULT_IGNORE_NAMES.has(segment));
}

/** Compute the sha256 of a single file as lowercase hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Recursively hash every regular file under `root`. Returns a map keyed by
 * POSIX-style relative paths from `root`. Symlinks are skipped (not followed)
 * to match the conservative behaviour of `copy.ts`.
 */
export async function sha256Dir(root: string, opts: Sha256DirOptions = {}): Promise<FileHashMap> {
  const result: FileHashMap = {};

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Missing directory → empty contribution. Lets `diffTree` treat the
      // other side as the authoritative source of entries.
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      // Symlinks are skipped for parity with copy.ts: following them could
      // escape the source tree or surface targets the caller never meant to
      // ship. The asset tree has no symlinks today, but upgrade diffs walk
      // user trees where symlinks are real.
      if (stat.isSymbolicLink()) continue;

      const rel = relative(root, full).split(sep).join("/");
      if (opts.ignore?.(rel)) continue;

      if (stat.isDirectory()) {
        await walk(full);
      } else if (stat.isFile()) {
        result[rel] = await sha256File(full);
      }
      // Other entry types (sockets, devices, fifos) are silently ignored — they
      // have no place in a sha256 diff.
    }
  };

  await walk(root);
  return result;
}

/**
 * Compare the package's payload subtrees against the matching subtrees in the
 * install target.
 *
 * The returned `modified` (and, if `--prune` is in play, `removed`) entries
 * use paths relative to the install target, so they can be passed straight
 * into `backup.createBackup` and `copy.copyDir` without re-mapping.
 */
export async function diffTree(
  target: string,
  pkgIncludes: PkgInclude[],
  opts: DiffTreeOptions = {},
): Promise<DiffPlan> {
  const ignore = opts.ignore ?? defaultIgnore;
  const assetsRoot = opts.assetsRoot;

  // Build fromHash (target, current install) and toHash (pkg, new version)
  // maps. Both are keyed by relPath from the matching subtree base, so as long
  // as pkgSubPath === targetSubPath the key spaces line up and the merge is
  // direct. pkgSubPath is resolved against the package's assets/ directory —
  // the same convention installCore uses (`resolveAsset`).
  const fromHash: FileHashMap = {};
  const toHash: FileHashMap = {};

  for (const inc of pkgIncludes) {
    const pkgAbs = assetsRoot ? join(assetsRoot, inc.pkgSubPath) : resolveAsset(inc.pkgSubPath);
    const targetAbs = join(target, inc.targetSubPath);
    const pkgMap = await sha256Dir(pkgAbs, { ignore });
    const targetMap = await sha256Dir(targetAbs, { ignore });
    // Re-key both maps with the targetSubPath prefix so the merged maps are
    // keyed by relPath-from-target (e.g. `docs/README.md`, `.pi/agents/a.md`).
    // That makes the plan entries directly usable by backup.createBackup and
    // copy.copyDir, which join them onto `target`.
    const prefix = inc.targetSubPath;
    for (const [rel, hash] of Object.entries(pkgMap)) {
      const key = prefix ? `${prefix}/${rel}` : rel;
      toHash[key] = hash;
    }
    for (const [rel, hash] of Object.entries(targetMap)) {
      const key = prefix ? `${prefix}/${rel}` : rel;
      fromHash[key] = hash;
    }
  }

  const plan: DiffPlan = { modified: [], added: [], removed: [], unchanged: [] };
  const seen = new Set<string>();
  for (const [rel, toHashValue] of Object.entries(toHash)) {
    seen.add(rel);
    if (!(rel in fromHash)) {
      plan.added.push({ relPath: rel, toHash: toHashValue });
    } else if (fromHash[rel] !== toHashValue) {
      plan.modified.push({ relPath: rel, fromHash: fromHash[rel], toHash: toHashValue });
    } else {
      plan.unchanged.push({ relPath: rel });
    }
  }
  for (const rel of Object.keys(fromHash)) {
    if (seen.has(rel)) continue;
    plan.removed.push({ relPath: rel, fromHash: fromHash[rel] });
  }

  // Deterministic output for tests + predictable upgrade logs.
  const byRel = (a: { relPath: string }, b: { relPath: string }): number =>
    a.relPath.localeCompare(b.relPath);
  plan.modified.sort(byRel);
  plan.added.sort(byRel);
  plan.removed.sort(byRel);
  plan.unchanged.sort(byRel);

  return plan;
}
