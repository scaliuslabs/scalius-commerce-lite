import type { AgentPrincipal } from "./types";

const AGENT_DISPATCH_PRINCIPAL = Symbol("scalius.agent-dispatch-principal");

type InternalAgentEnv = Env & {
  [AGENT_DISPATCH_PRINCIPAL]?: AgentPrincipal;
};

function isAgentPrincipal(value: unknown): value is AgentPrincipal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const principal = value as Partial<AgentPrincipal>;
  return (
    principal.kind === "agent" &&
    /^agr_[A-Za-z0-9_-]{20}$/.test(principal.grantId ?? "") &&
    (principal.credentialId === null ||
      /^agc_[A-Za-z0-9_-]{20}$/.test(principal.credentialId ?? "")) &&
    typeof principal.ownerUserId === "string" &&
    /^[\x21-\x7E]{1,160}$/.test(principal.ownerUserId) &&
    typeof principal.isSuperAdmin === "boolean" &&
    (principal.resource === "dashboard" || principal.resource === "storefront") &&
    (principal.grantKind === "oauth" || principal.grantKind === "pat" || principal.grantKind === "cli") &&
    (principal.preset === "read" || principal.preset === "operator" ||
      principal.preset === "full" || principal.preset === "custom") &&
    principal.permissions instanceof Set &&
    [...principal.permissions].every((permission) => typeof permission === "string") &&
    ["read", "write", "destructive", "financial", "security"].includes(
      principal.riskCeiling ?? "",
    ) &&
    typeof principal.authorityRevision === "number" &&
    Number.isSafeInteger(principal.authorityRevision) &&
    principal.authorityRevision > 0 &&
    principal.expiresAt instanceof Date &&
    Number.isFinite(principal.expiresAt.getTime())
  );
}

export function withAgentDispatchPrincipal(env: Env, principal: AgentPrincipal): Env {
  if (!isAgentPrincipal(principal)) throw new TypeError("Agent dispatch principal is invalid");
  const wrapped = Object.create(
    Object.getPrototypeOf(env),
    Object.getOwnPropertyDescriptors(env),
  ) as InternalAgentEnv;
  Object.defineProperty(wrapped, AGENT_DISPATCH_PRINCIPAL, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: principal,
  });
  return wrapped;
}

export function getAgentDispatchPrincipal(env: Env): AgentPrincipal | null {
  const principal = (env as InternalAgentEnv)[AGENT_DISPATCH_PRINCIPAL];
  return isAgentPrincipal(principal) ? principal : null;
}
