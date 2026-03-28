import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Options that control a text-based subprocess execution. */
export interface ExecTextOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Captured UTF-8 output from a subprocess call. */
export interface ExecTextResult {
  stdout: string;
  stderr: string;
}

/** Build one consistent exec configuration for all helper call sites. */
function buildExecOptions(options: ExecTextOptions): ExecFileOptionsWithStringEncoding {
  return {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: options.maxBuffer ?? 1_048_576,
    encoding: "utf8",
    windowsHide: true,
  };
}

/** Run a command without a shell and capture its UTF-8 stdout and stderr. */
export async function execFileText(
  file: string,
  args: string[],
  options: ExecTextOptions = {}
): Promise<ExecTextResult> {
  const result = await execFileAsync(file, args, buildExecOptions(options));
  return { stdout: result.stdout, stderr: result.stderr };
}
