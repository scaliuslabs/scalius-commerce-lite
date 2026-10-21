import type { AgentPrincipal, OperationPrincipal, PluginPrincipal } from "./types";

// The in-process dispatch principal rides on a non-enumerable symbol property
// of the Worker-created env: no HTTP header, cookie or body can forge it.
const OPERATION_DISPATCH_PRINCIPAL = Symbol("scalius.operation-dispatch-principal");

type InternalDispatchEnv = Env & {
  [OPERATION_DISPATCH_PRINCIPAL]?: OperationPrincipal;
};

const RISKS = ["read", "write", "destructive", "financial", "security"];
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

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
    RISKS.includes(principal.riskCeiling ?? "") &&
    typeof principal.authorityRevision === "number" &&
    Number.isSafeInteger(principal.authorityRevision) &&
    principal.authorityRevision > 0 &&
    principal.expiresAt instanceof Date &&
    Number.isFinite(principal.expiresAt.getTime())
  );
}

function isPluginPrincipal(value: unknown): value is PluginPrincipal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const principal = value as Partial<PluginPrincipal>;
  return (
    principal.kind === "plugin" &&
    PLUGIN_ID.test(principal.pluginId ?? "") &&
    typeof principal.version === "string" &&
    principal.version.length > 0 &&
    principal.version.length <= 80 &&
    typeof principal.pluginName === "string" &&
    typeof principal.actorUserId === "string" &&
    /^[\x21-\x7E]{1,160}$/.test(principal.actorUserId) &&
    principal.permissions instanceof Set &&
    [...principal.permissions].every((permission) => typeof permission === "string") &&
    // A plugin never holds security authority.
    RISKS.includes(principal.riskCeiling ?? "") &&
    principal.riskCeiling !== "security"
  );
}

/**
 * What the dispatcher already settled for a confirmation-gated step: the
 * merchant approved it (a redeemed dashboard approval or a client dialog), or it
 * is a native dry run that writes nothing. The admin boundary's confirm gate
 * (agent-access/confirm-gate.ts) reads it; nothing outside the dispatcher can
 * set it.
 */
export interface OperationDispatchClearance {
  confirmed: boolean;
  dryRun: boolean;
  /**
   * Check the request against the route's own validation and stop there: the
   * admin boundary answers 204 (valid) or the route's refusal, and nothing
   * runs. The MCP lane sends it before it asks anyone to approve a change.
   */
  validateOnly?: boolean;
}

const OPERATION_DISPATCH_CLEARANCE = Symbol("scalius.operation-dispatch-clearance");

/** A copy of `env` carrying the principal an in-process operation dispatch acts as. */
export function withOperationDispatchPrincipal(
  env: Env,
  principal: OperationPrincipal,
  clearance: OperationDispatchClearance = { confirmed: false, dryRun: false },
): Env {
  if (!isAgentPrincipal(principal) && !isPluginPrincipal(principal)) {
    throw new TypeError("Operation dispatch principal is invalid");
  }
  const wrapped = Object.create(
    Object.getPrototypeOf(env),
    Object.getOwnPropertyDescriptors(env),
  ) as InternalDispatchEnv;
  Object.defineProperty(wrapped, OPERATION_DISPATCH_PRINCIPAL, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: principal,
  });
  Object.defineProperty(wrapped, OPERATION_DISPATCH_CLEARANCE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      confirmed: clearance.confirmed === true,
      dryRun: clearance.dryRun === true,
      validateOnly: clearance.validateOnly === true,
    }),
  });
  return wrapped;
}

/** The dispatcher's clearance of the current step; none outside an in-process dispatch. */
export function getOperationDispatchClearance(env: Env): OperationDispatchClearance | null {
  const value = (env as Env & { [OPERATION_DISPATCH_CLEARANCE]?: OperationDispatchClearance })[OPERATION_DISPATCH_CLEARANCE];
  return value && typeof value === "object" ? value : null;
}

export function withAgentDispatchPrincipal(env: Env, principal: AgentPrincipal): Env {
  if (!isAgentPrincipal(principal)) throw new TypeError("Agent dispatch principal is invalid");
  return withOperationDispatchPrincipal(env, principal);
}

export function getAgentDispatchPrincipal(env: Env): AgentPrincipal | null {
  const principal = (env as InternalDispatchEnv)[OPERATION_DISPATCH_PRINCIPAL];
  return isAgentPrincipal(principal) ? principal : null;
}

export function getPluginDispatchPrincipal(env: Env): PluginPrincipal | null {
  const principal = (env as InternalDispatchEnv)[OPERATION_DISPATCH_PRINCIPAL];
  return isPluginPrincipal(principal) ? principal : null;
}
