import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CopyOptions {
  filter?: (source: string, relativePath: string) => boolean;
  dryRun?: boolean;
  /**
   * Called once per entry that is intentionally skipped. Callers can use
   * this to surface warnings (e.g. symlinks in the asset tree, which we
   * deliberately do not follow during a recursive copy).
   */
  onSkip?: (relativePath: string, reason: string) => void;
}

/** Recursively copy a directory, optionally filtering entries or running as a preview. */
export function copyDir(src: string, dest: string, options: CopyOptions = {}): void {
  const copy = (sourceDir: string, destinationDir: string, relativeDir: string): void => {
    for (const entry of readdirSync(sourceDir)) {
      const source = join(sourceDir, entry);
      const entryRelativePath = relativeDir ? join(relativeDir, entry) : entry;
      if (options.filter && !options.filter(source, entryRelativePath)) continue;

      const stat = lstatSync(source);
      // Symlinks are skipped (not followed, not copied). Following them could
      // escape the source tree or copy a target that the caller never meant
      // to ship; the asset tree has no symlinks today, but stage-2 diff/
      // backup work will traverse user trees where symlinks are real.
      if (stat.isSymbolicLink()) {
        options.onSkip?.(entryRelativePath, "symlink");
        continue;
      }

      const destination = join(destinationDir, entry);
      if (stat.isDirectory()) {
        if (!options.dryRun) mkdirSync(destination, { recursive: true });
        copy(source, destination, entryRelativePath);
      } else {
        if (options.dryRun) {
          console.log(`copy ${entryRelativePath}`);
        } else {
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(source, destination);
        }
      }
    }
  };

  copy(src, dest, "");
}