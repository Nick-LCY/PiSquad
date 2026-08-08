import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget, stateFile } from "../lib/paths.js";
import { which } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { atomicWriteFile } from "../lib/fs-safe.js";
import { decideChannels, type Channels } from "../lib/ui.js";
import { writeState, readState } from "../lib/version.js";
import { installChannels } from "../lib/plugins/index.js";

export interface InstallOptions {
  target?: string;
  yes?: boolean;
  with?: string;
  without?: string;
  all?: boolean;
  dryRun?: boolean;
}

interface EnvironmentProbe {
  node: boolean;
  npm: boolean;
  codegraph: boolean;
  entire: boolean;
}

function probeEnvironment(): EnvironmentProbe {
  return {
    node: which("node") !== null,
    npm: which("npm") !== null,
    codegraph: which("codegraph") !== null,
    entire: which("entire") !== null,
  };
}

function paintInstalled(channel: string): string {
  return `\u2713 ${channel}`;
}

function printChannelSummary(channels: Channels): void {
  logger.info("Channels installed:");
  logger.info(`  ${paintInstalled("core")} (always)`);
  logger.info(`  ${channels.codegraph ? paintInstalled("codegraph") : "  codegraph"}`);
  logger.info(`  ${channels.entire ? paintInstalled("entire") : "  entire"}`);
}

function appendGitignoreRule(target: string): void {
  const gitignore = join(target, ".gitignore");
  if (!existsSync(gitignore)) return;
  const existing = readFileSync(gitignore, "utf8");
  if (existing.includes(".pi/.pisquad/")) return;
  const sep = existing.endsWith("\n") ? "" : "\n";
  const next = `${existing}${sep}.pi/.pisquad/\n`;
  // Atomic so a crash mid-write cannot truncate the user's existing .gitignore.
  atomicWriteFile(gitignore, next);
  logger.info("appended .pi/.pisquad/ to .gitignore");
}

/**
 * Full install pipeline. The Commander layer (main.ts) routes here.
 *
 * Behavioural contract:
 * - Refuses to run when <target>/.pi/.pisquad/state.json already exists; the
 *   user must use `pisquad upgrade` instead.
 * - Refuses when node or npm are missing (hard requirement for core).
 * - Refuses only when an optional channel is requested AND its host CLI is
 *   missing.
 * - Honors the non-interactive contract: no tty + no flags → core only, exit 0.
 * - Honors --dry-run end-to-end (no writes, including state.json).
 */
export async function installCommand(options: InstallOptions): Promise<void> {
  const target = resolveTarget(options.target);
  const env = probeEnvironment();
  const dryRun = options.dryRun === true;

  logger.info(`pisquad install → ${target}${dryRun ? " (dry-run)" : ""}`);

  if (!env.node || !env.npm) {
    logger.error("node and npm are required to install pi-squad");
    logger.error("install Node.js 18+ from https://nodejs.org/ (which includes npm) and try again");
    process.exitCode = 1;
    return;
  }

  const existing = readState(target);
  if (existing) {
    logger.error("pi-squad is already installed in this directory");
    logger.error(`state file: ${stateFile(target)}`);
    logger.error("re-run with \`pisquad upgrade\` to update an existing installation");
    logger.error("(upgrade lands in stage 2; for now, remove the state file or pick another target)");
    process.exitCode = 1;
    return;
  }

  const channels = await decideChannels({
    all: options.all,
    with: options.with,
    without: options.without,
    yes: options.yes,
    target,
  });

  // Gate optional channels on their host CLI availability.
  if (channels.codegraph && !env.codegraph) {
    logger.error("channel 'codegraph' was requested but the codegraph CLI is not on PATH");
    logger.error("install it from https://github.com/... (or omit 'codegraph' from --with / --all)");
    process.exitCode = 1;
    return;
  }
  if (channels.entire && !env.entire) {
    logger.error("channel 'entire' was requested but the entire CLI is not on PATH");
    logger.error("install it from https://entire.io (or omit 'entire' from --with / --all)");
    process.exitCode = 1;
    return;
  }

  try {
    await installChannels(target, channels, { dryRun });
  } catch (error) {
    logger.error(`install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    logger.info("DRY RUN — no changes made");
    return;
  }

  writeState(target, { channels });
  appendGitignoreRule(target);

  printChannelSummary(channels);
  logger.success("install complete");
  logger.info(`state file: ${stateFile(target)}`);
}
