// Route-to-operation lookups on the hot admin and plugin paths. They read the
// small policy index only; the full manifest (schemas, prose) loads when an
// agent describes or calls an operation.
import { AGENT_OPERATION_POLICIES, AGENT_OPERATION_POLICIES_BY_ID } from "../generated/agent-operation-policies.gen";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";

function matchPathTemplate(template: string, pathname: string): boolean {
  const templateSegments = template.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) =>
    /^\{[^}]+\}$/.test(segment) || segment === pathSegments[index],
  );
}

function pathTemplateSpecificity(template: string): number {
  return template.split("/").filter(Boolean).reduce(
    (score, segment) => score + (/^\{[^}]+\}$/.test(segment) ? 0 : 1),
    0,
  );
}

export function resolveDirectAgentOperation(
  method: string,
  pathname: string,
): AgentOperationPolicy | null {
  const normalizedMethod = method.toUpperCase();
  const matches = AGENT_OPERATION_POLICIES.filter((operation) =>
    operation.method === normalizedMethod && matchPathTemplate(operation.pathTemplate, pathname),
  );
  if (matches.length === 0) return null;
  const highestSpecificity = Math.max(
    ...matches.map((operation) => pathTemplateSpecificity(operation.pathTemplate)),
  );
  const mostSpecific = matches.filter((operation) =>
    pathTemplateSpecificity(operation.pathTemplate) === highestSpecificity,
  );
  return mostSpecific.length === 1 ? (mostSpecific[0] ?? null) : null;
}

export function resolveAgentOperationById(
  operationId: string,
): AgentOperationPolicy | null {
  return Object.hasOwn(AGENT_OPERATION_POLICIES_BY_ID, operationId)
    ? AGENT_OPERATION_POLICIES_BY_ID[operationId] ?? null
    : null;
}
