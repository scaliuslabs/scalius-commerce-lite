import { CliError, exitCodeForHttpStatus } from "./errors.js";
import type { Runtime } from "./types.js";

const MAX_ERROR_BYTES = 16 * 1024;
const TOKEN_PATTERN = /sc_(?:pat|cli)_agc_[A-Za-z0-9_-]{20}_[A-Za-z0-9_-]{43}/g;

function redact(value: string): string {
  return value.replace(TOKEN_PATTERN, "[REDACTED_CREDENTIAL]");
}

export async function fetchWithNetworkErrors(runtime: Runtime, input: string, init?: RequestInit): Promise<Response> {
  try {
    return await runtime.fetch(input, init);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new CliError(130, "interrupted", "Operation interrupted.");
    }
    throw new CliError(7, "network_error", error instanceof Error ? error.message : "Network request failed.");
  }
}

export async function responseError(response: Response, fallback: string): Promise<CliError> {
  let message = fallback;
  let code = `http_${response.status}`;
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BYTES);
    if (text) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const nested = typeof parsed.error === "object" && parsed.error ? parsed.error as Record<string, unknown> : undefined;
      const candidate = nested?.message ?? parsed.message ?? parsed.error;
      const candidateCode = nested?.code ?? parsed.code;
      if (typeof candidate === "string" && candidate.length <= 1_000) message = redact(candidate);
      if (typeof candidateCode === "string" && candidateCode.length <= 100) code = candidateCode;
    }
  } catch {
    // Fall back to a bounded local message; do not echo arbitrary response text.
  }
  return new CliError(exitCodeForHttpStatus(response.status), code, message, { status: response.status });
}

export function bearerHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  return headers;
}
