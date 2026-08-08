import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CopyOptions {
  filter?: (source: string, relativePath: string) => boolean;
  dryRun?: boolean;
}

/** Recursively copy a directory, optionally filtering entries or running as a preview. */
export function copyDir(src: string, dest: string, options: CopyOptions = {}): void {
  const copy = (sourceDir: string, destinationDir: string, relativeDir: string): void => {
    for (const entry of readdirSync(sourceDir)) {
      const source = join(sourceDir, entry);
      const entryRelativePath = relativeDir ? join(relativeDir, entry) : entry;
      if (options.filter && !options.filter(source, entryRelativePath)) continue;

      const destination = join(destinationDir, entry);
      if (statSync(source).isDirectory()) {
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
