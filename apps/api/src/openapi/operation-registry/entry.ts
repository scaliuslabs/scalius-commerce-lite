// The shape of one agent operation registry row.
import type {
  AgentArtifactOutput,
  AgentMoneyFields,
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
  /**
   * Default: `["admin"]` for dashboard/system and for a storefront operation
   * only an agent grant reaches (its grant belongs to a 2FA administrator),
   * `["visitor","customer"]` for the rest of the storefront.
   */
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
   * The app-API tier (`x-scalius-agent.stability`, packages/plugin-sdk/docs/apps.md
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
   * Default: `"money"` for `financial` risk, else `"none"`.
   * - `"money"`: the write moves or forgoes money, or changes who is paid or
   *   what is charged (prices, discounts, fees, taxes, currency, payment
   *   methods, who a price list or net terms reach). Agent approval treats it
   *   as financial.
   * - `"security"`: it changes what code runs on the storefront, where buyers
   *   are sent, or who receives store data. Agent approval treats it as a
   *   security change.
   * Either way its risk, and so the grant ceilings that reach it, stay as
   * they are (`mcp/confirm.ts`). A write that sets money only in some of its
   * fields declares `moneyFields` instead. Every executable write is
   * classified in `money-impact.test.ts`.
   */
  impact?: "money" | "security";
  /**
   * The fields that move money in a write that also edits other things (a
   * product's price beside its description): approval is asked only when the
   * request sets one of them to a value other than the stored one. `read` is
   * the operation that returns the stored values, `readPath` maps its path
   * parameters from this one's (default: same names; `=base` is a literal value), and `fields` maps each
   * input JSON pointer (`/body/price`) to the read's pointer (`/data/price`;
   * a segment `[id={variantId}]` picks the list item with that id), or null
   * when no read holds it (present means changed). `preconditions` name the
   * write's revision (or the stored values it expects) and where the read
   * shows them: unless each is sent and equal, the fields count as changed,
   * and when they are equal the route's own check keeps them so.
   */
  moneyFields?: AgentMoneyFields;
  /**
   * An opt-in grant scope: no preset grant (Read only, Operator, Full
   * automation) reaches the operation; a Custom grant whose permission
   * snapshot holds the route permission does (AGENT-ACCESS.md).
   */
  grantScope?: AgentOperationGrantScope;
};
