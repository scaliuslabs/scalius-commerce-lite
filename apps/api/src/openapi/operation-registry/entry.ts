// The shape of one agent operation registry row.
import type {
  AgentArtifactOutput,
  AgentContinuationOutput,
  AgentOperationBatch,
  AgentOperationDryRun,
  AgentOperationGrantScope,
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
  /**
   * Default `"none"`; `"supported"` for a stable mutating operation, which
   * replays its first response for a repeated `Idempotency-Key` for 24 hours
   * (`routes/admin/idempotency.ts`).
   */
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
   * The app-API tier (`x-scalius-agent.stability`, docs/platform/PLUGINS.md
   * "Stable operations"). An operation is `"stable"` exactly when the sealed
   * app-name table lists it (`STABLE_APP_OPERATIONS` in
   * `@scalius/shared/plugins/app-operations`): its request and response
   * schemas are snapshotted (`stable-operations.snapshot.json`) and only
   * additive changes pass. Otherwise the default is `"beta"` for executable
   * dashboard and storefront operations (bundled first-party apps may call
   * them; they can change) and `"internal"` for everything else; a row may
   * say `"internal"` (no app ever calls it: staff, app and maintenance
   * areas).
   *
   * Agents (MCP, CLI) ignore the tier: their own grant decides.
   */
  stability?: "internal";
  /**
   * Marks an executable dashboard operation that is deliberately outside the
   * curated agent intents in `agent-access/workflows/routes-dashboard.ts`.
   */
  uncurated?: true;
  /**
   * Default `"none"`. `"native"`: the route takes `dryRun: true` (JSON body,
   * or query for a body-less method), checks everything and writes nothing.
   * `"preview:<operationId>"`: a reviewed read on the same surface previews
   * this write (discounts, taxes, order amendments).
   */
  dryRun?: AgentOperationDryRun;
  /**
   * Default: `"required"` for `destructive` and `financial` risk, else
   * `"none"`. A row may only add the gate (stored value, bearer codes).
   */
  confirmation?: "required";
  /**
   * An opt-in grant scope: no preset grant (Read only, Operator, Full
   * automation) reaches the operation; a Custom grant whose permission
   * snapshot holds the route permission does (AGENT-ACCESS.md).
   */
  grantScope?: AgentOperationGrantScope;
};
