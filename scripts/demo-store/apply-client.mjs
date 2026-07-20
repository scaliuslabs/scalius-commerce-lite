const MAX_MUTATION_RESPONSE_BYTES = 1_000_000;

export class ApplyHttpError extends Error {
  constructor(status, code = null) {
    super(`Admin command failed with HTTP ${status}${code ? ` (${code})` : ""}.`);
    this.name = "ApplyHttpError";
    this.status = status;
    this.code = code;
  }
}

async function responseBody(response) {
  const text = await response.text();
  if (text.length > MAX_MUTATION_RESPONSE_BYTES) throw new Error("Admin command response exceeded the safe size limit.");
  try { return text ? JSON.parse(text) : null; } catch { throw new Error("Admin command response was not valid JSON."); }
}

export function createApplyClient({ adminOrigin, cookieHeader, fetchImpl = fetch, timeoutMs = 20_000 }) {
  return {
    async send(command) {
      let response;
      try {
        response = await fetchImpl(`${adminOrigin}${command.path}`, {
          method: command.method,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json", "content-type": "application/json", cookie: cookieHeader, origin: adminOrigin },
          body: JSON.stringify(command.body),
        });
      } catch (error) {
        throw new Error("Admin command ended without a definitive HTTP response.", { cause: error });
      }
      const body = response.status === 204 ? null : await responseBody(response);
      if (!response.ok) {
        const code = typeof body?.error === "object" ? body.error.code ?? null : null;
        throw new ApplyHttpError(response.status, code);
      }
      return body?.data ?? body;
    },
  };
}
