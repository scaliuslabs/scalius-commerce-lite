import { ForbiddenError, NotFoundError } from "../utils/api-error";
import { isAgentRiskAllowed, type AgentPrincipal, type AgentRisk } from "./types";

export interface ManagedConnectionAuthority {
  id: string;
  ownerUserId: string | null;
  resource: string;
}

export interface SubordinateGrantAuthority {
  resource: "dashboard" | "storefront";
  permissions: string[];
  riskCeiling: AgentRisk;
  expiresAt: Date;
}

export function getAgentConnectionListScope(
  principal: AgentPrincipal | undefined,
): { ownerUserId: string; resource: AgentPrincipal["resource"] } | Record<string, never> {
  return principal
    ? { ownerUserId: principal.ownerUserId, resource: principal.resource }
    : {};
}

export function assertAgentConnectionScope(
  connection: ManagedConnectionAuthority,
  principal: AgentPrincipal | undefined,
  selfOnly = false,
): void {
  if (!principal) return;
  if (
    connection.ownerUserId !== principal.ownerUserId ||
    connection.resource !== principal.resource ||
    (selfOnly && connection.id !== principal.grantId)
  ) {
    // Conceal foreign grant existence from agent credentials.
    throw new NotFoundError("Agent connection not found");
  }
}

export function assertSubordinateGrantSelection(
  selection: SubordinateGrantAuthority,
  principal: AgentPrincipal | undefined,
): void {
  if (!principal) return;
  if (
    selection.resource !== principal.resource ||
    selection.permissions.some((permission) => !principal.permissions.has(permission)) ||
    !isAgentRiskAllowed(principal.riskCeiling, selection.riskCeiling) ||
    selection.expiresAt > principal.expiresAt
  ) {
    throw new ForbiddenError(
      "A connection cannot exceed the caller's permissions, resource, risk, or lifetime",
    );
  }
}
