import { homedir } from "node:os";
import open from "open";
import type { Runtime } from "./types.js";

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
  };
}
