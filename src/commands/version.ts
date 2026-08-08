import { readCliVersion, resolveAssetsVersion } from "../lib/version.js";

/**
 * Print CLI and assets versions.
 * Format: `pisquad <cliVersion> (assets <version>)`
 */
export function versionCommand(): void {
  const cliVersion = readCliVersion();
  const assetsVersion = resolveAssetsVersion(cliVersion);
  console.log(`pisquad ${cliVersion} (assets ${assetsVersion})`);
}
