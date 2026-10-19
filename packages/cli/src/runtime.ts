import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import open from "open";
import type { CommandRunner, Runtime } from "./types.js";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

/** Runs a harness CLI with literal arguments (no shell), bounded in time and output. */
export function createCommandRunner(env: NodeJS.ProcessEnv): CommandRunner {
  return (command, args, options = {}) => new Promise((resolve) => {
    execFile(command, args, {
      env,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = !failure ? 0 : typeof failure.code === "number" ? failure.code : failure.code === "ENOENT" ? 127 : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function entryScript(): string | undefined {
  const script = process.argv[1];
  if (!script) return undefined;
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

export function createRuntime(): Runtime {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new DOMException("Interrupted", "AbortError")));
  process.once("SIGTERM", () => controller.abort(new DOMException("Interrupted", "AbortError")));
  return {
    env: process.env,
    fetch: globalThis.fetch,
    homedir,
    now: Date.now,
    openUrl: (url) => open(url),
    platform: process.platform,
    signal: controller.signal,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    run: createCommandRunner(process.env),
    entryScript: entryScript(),
  };
}
