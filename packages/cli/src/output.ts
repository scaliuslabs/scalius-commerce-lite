import type { OutputMode, Runtime } from "./types.js";
import type { CliError } from "./errors.js";

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeResult(runtime: Runtime, mode: OutputMode, value: unknown, human?: string): void {
  if (mode === "json") {
    runtime.stdout.write(stableJson(value));
    return;
  }
  runtime.stdout.write(human ? `${human}\n` : stableJson(value));
}

export function writeDiagnostic(runtime: Runtime, message: string): void {
  runtime.stderr.write(`${message}\n`);
}

export function writeError(runtime: Runtime, mode: OutputMode, error: CliError): void {
  if (mode === "json") {
    runtime.stderr.write(stableJson({
      error: {
        code: error.errorCode,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }));
    return;
  }
  runtime.stderr.write(`Error: ${error.message}\n`);
}
