// The operator's read of the API's /readyz: an anonymous caller learns only
// ready or not ready and the class of what failed (`reasons`); the readiness
// token (derived from SCALIUS_SECRET, taken from the shell, never from a
// file; it unlocks nothing else) in `X-API-Token` gets every check's detail.
// Shared by ops:check, release:check and the deploy script.

export const READINESS_OPERATOR_HEADER = "X-API-Token";

/** The readiness token for the detailed read, or null when the shell holds no master secret. */
export async function readinessOperatorToken(env = process.env) {
  // No master secret in the shell: the anonymous read, with nothing loaded.
  if (!String(env.SCALIUS_SECRET ?? "").trim()) return null;
  const { deriveRuntimeSecret, readMasterSecret, OPS_READINESS_PURPOSE } = await import(
    new URL("../packages/shared/src/runtime-secrets.ts", import.meta.url).href
  );
  const master = readMasterSecret(env);
  return master ? deriveRuntimeSecret(master, OPS_READINESS_PURPOSE) : null;
}

/** The request headers of a readiness read: the operator's token when there is one. */
export function readinessHeaders(operatorToken) {
  return operatorToken ? { [READINESS_OPERATOR_HEADER]: operatorToken } : {};
}

/** The checks of a readiness answer, or null for an anonymous one. */
export function readinessChecksOf(payload) {
  const checks = payload?.checks;
  return checks && typeof checks === "object" ? checks : null;
}

/** One line for a log: every check with its status (the operator's read), else the anonymous status and reasons. */
export function readinessSummary(payload) {
  const checks = readinessChecksOf(payload);
  if (checks) {
    return Object.entries(checks)
      .map(([name, check]) => {
        const status = typeof check?.status === "string" ? check.status : "unknown";
        const latency = typeof check?.latencyMs === "number" ? ` ${check.latencyMs}ms` : "";
        return `${name}:${status}${latency}`;
      })
      .join(", ");
  }
  if (typeof payload?.status !== "string") return "no readiness payload";
  const reasons = Array.isArray(payload.reasons) && payload.reasons.length > 0 ? ` (${payload.reasons.join(", ")})` : "";
  return `${payload.status}${reasons}`;
}
