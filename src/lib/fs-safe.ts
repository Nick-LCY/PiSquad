import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

/** Write a file through a same-directory temporary file and atomic rename. */
export function atomicWriteFile(path: string, content: string): void {
  ensureDir(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

/** Remove a directory only when it exists and is empty. */
export function removeIfEmpty(path: string): boolean {
  if (!existsSync(path)) return false;
  if (readdirSync(path).length !== 0) return false;
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}
