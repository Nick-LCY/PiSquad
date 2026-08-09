import { defineConfig } from "tsup";

/**
 * Build config for the pisquad CLI.
 *
 * We keep `@inquirer/prompts` and `@inquirer/core` as `external` packages
 * instead of bundling them. Why:
 *
 *   1. `@inquirer/prompts` is a pure re-export barrel. tsup (esbuild
 *      under the hood) would otherwise follow its `export ... from
 *      "@inquirer/editor"` / `expand` / etc. into the bundle, and pull
 *      in transitive CommonJS deps like `yoctocolors-cjs` (and the
 *      `chardet` / `iconv-lite` used by `@inquirer/external-editor`).
 *   2. Those CJS modules do `require("tty")` (etc.) at module
 *      initialisation. tsup wraps them in a `__commonJS` shim whose
 *      fallback `require` throws `Dynamic require of "tty" is not
 *      supported` under the ESM output — see the runtime crash on
 *      `node dist/bin.js upgrade --help`.
 *   3. By keeping them external, Node's ESM loader handles the
 *      CJS/ESM interop natively (it wraps CJS as the default export)
 *      and the user's `require("tty")` inside `yoctocolors-cjs` works
 *      because the CJS module is loaded by Node's CJS loader, not
 *      inside our ESM bundle.
 *   4. Both packages are listed in `dependencies` (not
 *      `devDependencies`) so `npm install -g @nicklin/pisquad` will
 *      fetch them — and npm pulls the full transitive graph
 *      (`@inquirer/editor`, `@inquirer/external-editor`,
 *      `yoctocolors-cjs`, `chardet`, `iconv-lite`, ...) along with
 *      them automatically.
 */
export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["@inquirer/prompts", "@inquirer/core"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
