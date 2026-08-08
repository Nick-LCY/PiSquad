import { readdirSync, readFileSync } from "node:fs";
import { resolveAsset } from "./paths.js";

/** List the top-level payload entries shipped in the npm package's assets/. */
export function listAssets(): string[] {
  return readdirSync(resolveAsset("."), { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => name !== "assets-version.txt")
    .sort();
}

/** Read the content snapshot version shipped with the assets. */
export function readAssetsVersion(): string {
  const versionFile = resolveAsset(".pi/assets-version.txt");
  let version: string;
  try {
    version = readFileSync(versionFile, "utf8").trim();
  } catch (error) {
    throw new Error(`Missing assets version file: ${versionFile}`, { cause: error });
  }
  if (!version) throw new Error(`Assets version file is empty: ${versionFile}`);
  return version;
}
