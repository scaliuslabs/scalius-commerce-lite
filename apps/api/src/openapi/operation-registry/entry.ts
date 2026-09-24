// The shape of one agent operation registry row.
import type {
  AgentArtifactOutput,
  AgentContinuationOutput,
  AgentOperationBatch,
  AgentOperationExposure,
  AgentOperationIdempotency,
  AgentOperationPrincipal,
  AgentOperationRevision,
  AgentOperationRisk,
  AgentOperationTransport,
} from "../agent-operation-manifest";

/**
 * One declarative registry row per `/api/v1` agent operation (`operationId`).
 * Everything that can be derived is derived:
 *
 * - `surface` comes from the operation-ID prefix;
 * - `risk` defaults to the HTTP method (`GET`/`HEAD` read, otherwise write);
 * - `principals` default to the surface;
 * - `batch` defaults to the exposure and risk;
 * - RBAC comes from `getRoutePermission()` and the route path;
 * - summaries, schemas, tags, and request/response shapes come from the route.
 *
 * A row therefore records only the reviewed deviations from those defaults.
 * An empty row (`{}`) is a plain executable operation with surface defaults.
 *
 * `openapi-contract.ts` turns each row into `x-scalius-agent` metadata, and
 * `agent-operation-manifest.ts` derives its reviewed device, one-time-secret,
 * and continuation policy sets from the same rows.
 */
export type OperationRegistryEntry = {
  /** Default `"execute"`. */
  exposure?: Exclude<AgentOperationExposure, "execute">;
  /** Default: `["admin"]` for dashboard/system, `["visitor","customer"]` for storefront. */
  principals?: readonly AgentOperationPrincipal[];
  /** Default: `"read"` for `GET`/`HEAD` routes, `"write"` otherwise. */
  risk?: AgentOperationRisk;
  /** Default `false`. Set when the operation calls an external provider. */
  openWorld?: true;
  /** Default `"none"`. */
  idempotency?: Exclude<AgentOperationIdempotency, "none">;
  /** Default `"none"`. */
  revision?: Exclude<AgentOperationRevision, "none">;
  /** Default: `"forbidden"` unless executable, then `"parallel"` for reads and `"sequential"` for mutations. */
  batch?: AgentOperationBatch;
  /** Default `"json"`. */
  transport?: Exclude<AgentOperationTransport, "json">;
  /** Byte ceilings. Defaults: request 1 MiB, response 65,536. */
  limits?: { request?: number; response?: number };
  /** Default `false`. */
  sensitive?: true;
  /** Default `false`. Reviewed against {@link ONE_TIME_SECRET_OPERATION_IDS}. */
  oneTimeSecret?: true;
  clientAction?: "direct-upload";
  artifact?: AgentArtifactOutput;
  continuation?: AgentContinuationOutput;
  /** Required when `exposure` is `"excluded"`, forbidden otherwise. */
  reason?: string;
  /**
   * Marks an executable dashboard operation that is deliberately outside the
   * curated agent intents in `agent-access/workflows/routes-dashboard.ts`.
   */
  internal?: true;
};
