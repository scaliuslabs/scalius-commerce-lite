export type CliExitCode = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 130;

export class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly errorCode: string;
  readonly details?: unknown;

  constructor(exitCode: CliExitCode, errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

export function exitCodeForHttpStatus(status: number): CliExitCode {
  if (status === 401) return 3;
  if (status === 403) return 4;
  if (status === 409 || status === 412 || status === 428) return 6;
  if (status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504) return 7;
  if (status >= 400 && status < 500) return 5;
  return 8;
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new CliError(130, "interrupted", "Operation interrupted.");
  }
  return new CliError(8, "unexpected_error", error instanceof Error ? error.message : "Unexpected error.");
}
