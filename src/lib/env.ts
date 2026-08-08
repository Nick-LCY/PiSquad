import { execFileSync, spawn } from "node:child_process";

export interface ExecCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Return true only when both terminal streams are available and tty use is allowed. */
export function isInteractive(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    !process.env.CI &&
    !process.env.PISQUAD_NO_TTY
  );
}

/** Find an executable using the host platform's command lookup utility. */
export function which(cmd: string): string | null {
  if (!cmd) return null;

  try {
    const lookup = process.platform === "win32" ? "where.exe" : "sh";
    const args = process.platform === "win32" ? [cmd] : ["-c", 'command -v "$1"', "pisquad-which", cmd];
    const output = execFileSync(lookup, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const result = output.trim().split(/\r?\n/)[0];
    return result || null;
  } catch {
    return null;
  }
}

/** Execute a child process without a shell and capture all of its output. */
export function execCapture(cmd: string, args: string[] = []): Promise<ExecCaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode });
    };

    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      stderr += error instanceof Error ? error.message : String(error);
      finish(1);
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(1);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}
