// Route-to-operation lookups on the hot admin and plugin paths. They read the
// small policy index only; the full manifest (schemas, prose) loads when an
// agent describes or calls an operation.
import { AGENT_OPERATION_POLICIES, AGENT_OPERATION_POLICIES_BY_ID } from "../generated/agent-operation-policies.gen";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";

const PARAM_SEGMENT = /^\{[^}]+\}$/;

interface IndexedOperation {
  readonly operation: AgentOperationPolicy;
  /** A literal segment, or null where the template has a `{param}`. */
  readonly segments: readonly (string | null)[];
  readonly specificity: number;
}

function bucketKey(method: string, segmentCount: number): string {
  return `${method} ${segmentCount}`;
}

/** The static policy table bucketed by method and segment count, built once at module load. */
function buildOperationIndex(): ReadonlyMap<string, readonly IndexedOperation[]> {
  const index = new Map<string, IndexedOperation[]>();
  for (const operation of AGENT_OPERATION_POLICIES) {
    const segments = operation.pathTemplate
      .split("/")
      .filter(Boolean)
      .map((segment) => (PARAM_SEGMENT.test(segment) ? null : segment));
    const key = bucketKey(operation.method, segments.length);
    const entry: IndexedOperation = {
      operation,
      segments,
      specificity: segments.reduce((score, segment) => score + (segment === null ? 0 : 1), 0),
    };
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

const OPERATION_INDEX = buildOperationIndex();

export function resolveDirectAgentOperation(
  method: string,
  pathname: string,
): AgentOperationPolicy | null {
  const pathSegments = pathname.split("/").filter(Boolean);
  const bucket = OPERATION_INDEX.get(bucketKey(method.toUpperCase(), pathSegments.length));
  if (!bucket) return null;
  let best: AgentOperationPolicy | null = null;
  let bestSpecificity = -1;
  let tied = false;
  for (const entry of bucket) {
    if (entry.specificity < bestSpecificity) continue;
    if (!entry.segments.every((segment, i) => segment === null || segment === pathSegments[i])) {
      continue;
    }
    if (entry.specificity > bestSpecificity) {
      best = entry.operation;
      bestSpecificity = entry.specificity;
      tied = false;
    } else {
      tied = true;
    }
  }
  return best && !tied ? best : null;
}

export function resolveAgentOperationById(
  operationId: string,
): AgentOperationPolicy | null {
  return Object.hasOwn(AGENT_OPERATION_POLICIES_BY_ID, operationId)
    ? AGENT_OPERATION_POLICIES_BY_ID[operationId] ?? null
    : null;
}
