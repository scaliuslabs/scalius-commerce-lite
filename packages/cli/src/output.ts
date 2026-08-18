import type { OutputMode, Runtime } from "./types.js";
import type { CliError } from "./errors.js";

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compactJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function writeResult(runtime: Runtime, mode: OutputMode, value: unknown, human?: string): void {
  if (mode === "json") {
    runtime.stdout.write(compactJson(value));
    return;
  }
  runtime.stdout.write(human ? `${human}\n` : prettyJson(value));
}

export function writeDiagnostic(runtime: Runtime, message: string): void {
  runtime.stderr.write(`${message}\n`);
}

export function writeError(runtime: Runtime, mode: OutputMode, error: CliError): void {
  if (mode === "json") {
    runtime.stderr.write(compactJson({
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
