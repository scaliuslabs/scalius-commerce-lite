import { AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";

function matchPathTemplate(template: string, pathname: string): boolean {
  const templateSegments = template.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) =>
    /^\{[^}]+\}$/.test(segment) || segment === pathSegments[index],
  );
}

export function resolveDirectAgentOperation(
  method: string,
  pathname: string,
): AgentOperationManifestEntry | null {
  const normalizedMethod = method.toUpperCase();
  const matches = AGENT_OPERATIONS.filter((operation) =>
    operation.method === normalizedMethod && matchPathTemplate(operation.pathTemplate, pathname),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function resolveAgentOperationById(
  operationId: string,
): AgentOperationManifestEntry | null {
  const matches = AGENT_OPERATIONS.filter((operation) =>
    operation.operationId === operationId,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
