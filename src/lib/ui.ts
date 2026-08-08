import { checkbox } from "@inquirer/prompts";
import { isInteractive } from "./env.js";

export type OptionalChannel = "codegraph" | "entire";

export interface Channels {
  core: true;
  codegraph: boolean;
  entire: boolean;
}

export interface ChannelDecisionOptions {
  all?: boolean;
  with?: string | string[];
  without?: string | string[];
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  target?: string;
}

const coreOnly: Channels = { core: true, codegraph: false, entire: false };

/** Ask only about optional channels; core is deliberately always selected. */
export async function promptChannels(_target?: string): Promise<Channels> {
  const selected = await checkbox<OptionalChannel>({
    message: "Select optional pi-squad channels",
    choices: [
      { name: "codegraph", value: "codegraph" },
      { name: "entire", value: "entire" },
    ],
  });

  return {
    core: true,
    codegraph: selected.includes("codegraph"),
    entire: selected.includes("entire"),
  };
}

function values(input: string | string[] | undefined): string[] {
  if (input === undefined) return [];
  const parts = Array.isArray(input) ? input : input.split(",");
  return parts.map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function optionalChannels(input: string | string[] | undefined): Set<OptionalChannel> {
  const result = new Set<OptionalChannel>();
  for (const value of values(input)) {
    if (value === "codegraph" || value === "entire") result.add(value);
    else if (value !== "core") throw new Error(`Unknown channel: ${value}`);
  }
  return result;
}

function withChannels(channels: Set<OptionalChannel>): Channels {
  return {
    core: true,
    codegraph: channels.has("codegraph"),
    entire: channels.has("entire"),
  };
}

/**
 * Decide channels in the documented non-interactive precedence order.
 * Explicit flags win over environment variables; no tty always falls back to core.
 */
export async function decideChannels(opts: ChannelDecisionOptions = {}): Promise<Channels> {
  if (opts.all) return { core: true, codegraph: true, entire: true };

  const explicitWith = values(opts.with);
  const explicitWithout = values(opts.without);
  if (explicitWith.length > 0 && explicitWithout.length > 0) {
    throw new Error("Cannot combine --with and --without");
  }

  if (explicitWith.length > 0) {
    return withChannels(optionalChannels(explicitWith));
  }

  if (explicitWithout.length > 0) {
    const exclude = optionalChannels(explicitWithout);
    return {
      core: true,
      codegraph: !exclude.has("codegraph"),
      entire: !exclude.has("entire"),
    };
  }

  if (opts.yes) return { ...coreOnly };

  const env = opts.env ?? process.env;
  const environmentWith = values(env.PISQUAD_WITH);
  const environmentWithout = values(env.PISQUAD_WITHOUT);
  if (environmentWith.length > 0 && environmentWithout.length > 0) {
    throw new Error("Cannot combine PISQUAD_WITH and PISQUAD_WITHOUT");
  }

  if (environmentWith.length > 0) {
    return withChannels(optionalChannels(environmentWith));
  }

  if (environmentWithout.length > 0) {
    const exclude = optionalChannels(environmentWithout);
    return {
      core: true,
      codegraph: !exclude.has("codegraph"),
      entire: !exclude.has("entire"),
    };
  }

  if (isInteractive()) return promptChannels(opts.target);
  return { ...coreOnly };
}
