import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fs-safe.js";
import { execCapture, which } from "./env.js";

/** A file targeted for backup. `relPath` is relative to the install target. */
export interface BackupEntry {
  relPath: string;
}

export interface BackupResult {
  path: string;
  fileCount: number;
  bytes: number;
}

export interface BackupInfo {
  path: string;
  fileName: string;
  /** ISO timestamp embedded in the file name (no `:` or `.`), e.g. `20260115T103045Z`. */
  iso: string;
  label: string;
  bytes: number;
  modifiedAt: Date;
}

const FILE_NAME_RE = /^(\d{8}T\d{6}Z)-(.+)\.tar\.gz$/;

/** Directory under which upgrade-time backups are stored. */
export function backupDir(target: string): string {
  return join(target, ".pi", ".pisquad", "backups");
}

/**
 * Build the iso timestamp suffix used in backup file names per
 * `docs/conventions/install-state.md`: ISO 8601 with `:` and `.` stripped
 * (e.g. `2026-01-15T10:30:45.123Z` → `20260115T103045Z`).
 */
export function isoStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Reduce a caller-supplied label to a tar-safe form. Spaces, slashes, control
 * characters and shell metacharacters are collapsed into `-`; leading/trailing
 * dashes are trimmed. Empty results are rejected.
 */
export function sanitizeLabel(label: string): string {
  const sanitized = label.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(`backup: invalid label ${JSON.stringify(label)}`);
  }
  return sanitized;
}

/**
 * Tar up the listed files into
 * `<target>/.pi/.pisquad/backups/<iso>-<label>.tar.gz`. Paths inside the
 * archive are relative to `target` (e.g. `docs/README.md`).
 *
 * The system `tar` CLI is required. A missing tar is a hard error: backup is
 * the upgrader's safety net, so silently degrading it would defeat PRD §6.
 * If we ever need stronger cross-platform guarantees we can swap in the
 * `tar` npm package here.
 */
export async function createBackup(
  target: string,
  files: BackupEntry[],
  label: string,
): Promise<BackupResult> {
  if (files.length === 0) {
    throw new Error("createBackup: no files to back up");
  }
  if (which("tar") === null) {
    throw new Error(
      "createBackup: system 'tar' command not found on PATH — backups require tar to safely archive user changes",
    );
  }

  const safeLabel = sanitizeLabel(label);
  const dir = backupDir(target);
  ensureDir(dir);

  const stamp = isoStamp();
  const fileName = `${stamp}-${safeLabel}.tar.gz`;
  const out = join(dir, fileName);

  // Validate every file exists and is a regular file. A backup that quietly
  // drops a file is worse than no backup: the upgrader would overwrite a
  // file that was never archived.
  const rels: string[] = [];
  for (const f of files) {
    const abs = join(target, f.relPath);
    if (!existsSync(abs)) {
      throw new Error(`createBackup: file does not exist: ${f.relPath}`);
    }
    const stat = lstatSync(abs);
    if (!stat.isFile()) {
      throw new Error(`createBackup: not a regular file: ${f.relPath}`);
    }
    rels.push(f.relPath);
  }

  const result = await execCapture("tar", ["-czf", out, "-C", target, ...rels]);
  if (result.exitCode !== 0) {
    throw new Error(
      `createBackup: tar exited ${result.exitCode}\nstderr: ${result.stderr.trim()}`,
    );
  }

  const stat = statSync(out);
  console.log(`Backed up ${files.length} files → ${out}`);
  return { path: out, fileCount: files.length, bytes: stat.size };
}

/** List existing backups in ascending iso-timestamp order. Non-matching files are ignored. */
export function listBackups(target: string): BackupInfo[] {
  const dir = backupDir(target);
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const match = FILE_NAME_RE.exec(name);
    if (!match) continue;
    const [, iso, label] = match;
    const path = join(dir, name);
    const stat = statSync(path);
    out.push({ path, fileName: name, iso, label, bytes: stat.size, modifiedAt: stat.mtime });
  }
  out.sort((a, b) => a.iso.localeCompare(b.iso));
  return out;
}

/**
 * Delete backups whose iso timestamp is strictly before `before`. Returns the
 * number of files pruned. Intentionally not auto-invoked by upgrade — reserved
 * for the future `pisquad restore` workflow.
 */
export function pruneBackup(target: string, before: Date): number {
  const beforeIso = isoStamp(before);
  let pruned = 0;
  for (const b of listBackups(target)) {
    if (b.iso >= beforeIso) continue;
    try {
      unlinkSync(b.path);
      pruned++;
    } catch {
      // Best-effort: leave unremovable files for the user to inspect.
    }
  }
  return pruned;
}
