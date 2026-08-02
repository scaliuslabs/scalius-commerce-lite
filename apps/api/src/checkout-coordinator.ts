import {
  CHECKOUT_COMMIT_MAX_JSON_BYTES,
  CHECKOUT_COMMIT_MAX_ORDERS,
  CHECKOUT_RESERVATION_LANE_COUNT,
  buildCheckoutCommitStatements,
  buildCheckoutReservationLaneSnapshotStatement,
  buildEnsureCheckoutReservationLanesStatement,
  buildExistingCheckoutIdentityStatement,
  buildRebalanceCheckoutReservationLanesStatements,
  type CheckoutCommitCommand,
  type CheckoutReservationEdge,
  type CheckoutReservationLaneSnapshotRow,
  type CheckoutReservationLaneRebalance,
  type ExistingCheckoutIdentityRow,
  type PreparedCheckoutCommit,
} from "@scalius/database/checkout-commit";
import {
  createCheckoutSqlTransport,
  type CheckoutSqlTransport,
} from "@scalius/database/checkout-transport";
import {
  CHECKOUT_PROJECTION_MAX_ORDERS,
  CHECKOUT_PROJECTION_MAX_OUTBOXES,
  buildCheckoutProjectionBatchStatements,
} from "@scalius/database/checkout-projection";
import { getDb, type Database } from "@scalius/database/client";
import {
  assertGuestStorefrontCheckoutPolicy,
  createStorefrontCheckoutAuthorityBatchReadPlan,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  prepareCheckoutCommitCommand,
  type AtomicCheckoutAttempt,
  type CreateStorefrontOrderInput,
  type StorefrontOrderCommitPayload,
} from "@scalius/core/modules/orders";
import { AppError } from "@scalius/core/errors";
import type { MetaPurchaseQueueMessage } from "@scalius/core/integrations/meta/purchase-outbox";
import type { OrderNotificationQueueMessage } from "@scalius/core/modules/notifications";
import { fromMinorUnits } from "@scalius/core/modules/tax";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCredentialEncryptionKey } from "./utils/encryption-key";

const COORDINATOR_BUILD = "checkout-coordinator-v1";
const COORDINATOR_NAME = "storefront-checkout-v1";
const IDLE_FLUSH_MS = 2;
const INGRESS_QUIET_FLUSH_MS = 50;
const TARGET_BATCH_ORDERS = CHECKOUT_COMMIT_MAX_ORDERS;
const TARGET_BATCH_JSON_BYTES = 1_300_000;
const MAX_RECOVERY_ATTEMPTS = 1;
const MAX_RECENT_COMMITS = 4_096;
const VARIANT_READ_CHUNK = 90;
const AUTHORITY_CACHE_MAX_ENTRIES = 32;
const AUTHORITY_CACHE_TTL_MS = 30_000;
const CHECKOUT_SIDE_EFFECT_QUEUE_BATCH_SIZE = 100;
const CHECKOUT_SIDE_EFFECT_QUEUE_DELAY_SECONDS = 5;
const CHECKOUT_PROJECTION_MAX_DEFERRED_ORDERS = 1_000;
const CHECKOUT_PROJECTION_MAX_DEFER_MS = 5_000;

type JsonObject = Record<string, unknown>;
type Command = CheckoutCommitCommand<JsonObject, JsonObject>;

export type CheckoutCoordinatorResult =
  | {
      ok: true;
      orderId: string;
      response: JsonObject;
      replay: boolean;
      availabilityChangedSubjects: Array<{
        productId: string;
        slug: string | null;
        categoryId: string | null;
      }>;
    }
  | {
      ok: false;
      code:
        | "CHECKOUT_IDEMPOTENCY_CONFLICT"
        | "CHECKOUT_AUTHORITY_CHANGED"
        | "CHECKOUT_INVENTORY_UNAVAILABLE"
        | "CHECKOUT_COMMIT_UNAVAILABLE";
    };

export interface CheckoutIntentCommand {
  attempt: AtomicCheckoutAttempt;
  data: CreateStorefrontOrderInput;
  requestUrl: string;
}

export type CheckoutIntentCoordinatorResult =
  | (Extract<CheckoutCoordinatorResult, { ok: true }> & {
      postCommitPayload: StorefrontOrderCommitPayload | null;
    })
  | Exclude<CheckoutCoordinatorResult, { ok: true }>
  | {
      ok: false;
      code: "CHECKOUT_REJECTED";
      status: number;
      errorCode: string;
      message: string;
      details?: unknown;
    };

interface PendingCheckoutIntent {
  command: CheckoutIntentCommand;
  resolvers: Array<(result: CheckoutIntentCoordinatorResult) => void>;
}

interface PendingCheckout {
  command: Command;
  resolvers: Array<(result: CheckoutCoordinatorResult) => void>;
  recoveryAttempts: number;
}

interface ReservationLaneState {
  variantId: string;
  productId: string;
  productSlug: string | null;
  categoryId: string | null;
  lane: number;
  capacity: number;
  reservedQuantity: number;
  laneVersion: number;
  sourceStockVersion: number;
  stock: number;
  legacyReservedStock: number;
}

interface PreparedLaneBatch {
  pending: PendingCheckout[];
  commits: PreparedCheckoutCommit<JsonObject, JsonObject>[];
  finalStates: Map<string, ReservationLaneState>;
  availabilityChangedSubjects: Array<{
    productId: string;
    slug: string | null;
    categoryId: string | null;
  }>;
}

interface PendingCheckoutProjection {
  outboxId: string;
  orderCount: number;
  queuedAt: number;
  sideEffectMessages: CheckoutSideEffectQueueMessage[];
}

type CheckoutSideEffectQueueMessage =
  | OrderNotificationQueueMessage
  | MetaPurchaseQueueMessage;

interface CheckoutSideEffectQueue {
  sendBatch(
    messages: Array<{ body: CheckoutSideEffectQueueMessage }>,
    options?: { delaySeconds?: number },
  ): Promise<void>;
}

interface CheckoutAuthorityCacheEntry {
  expiresAt: number;
  results: readonly unknown[];
}

function laneStateKey(variantId: string, lane: number): string {
  return `${variantId}\0regular\0${lane}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCheckoutCommand(value: unknown): value is Command {
  if (!isJsonObject(value)) return false;
  const candidate = value as Partial<Command>;
  if (
    typeof candidate.requestKey !== "string"
    || typeof candidate.requestHash !== "string"
    || typeof candidate.receiptHash !== "string"
    || !Number.isSafeInteger(candidate.authorityRevision)
    || Number(candidate.authorityRevision) < 1
    || !isJsonObject(candidate.order)
    || !isJsonObject(candidate.aggregate)
    || !isJsonObject(candidate.response)
    || !Array.isArray(candidate.reservations)
    || candidate.reservations.length > 99
  ) {
    return false;
  }
  if (
    !candidate.requestKey
    || candidate.requestKey.length > 320
    || !candidate.requestHash
    || candidate.requestHash.length > 320
    || !candidate.receiptHash
    || candidate.receiptHash.length > 320
    || typeof candidate.order.id !== "string"
    || !candidate.order.id
    || candidate.order.id.length > 180
  ) {
    return false;
  }
  return candidate.reservations.every((reservation) =>
    isJsonObject(reservation)
    && typeof reservation.variantId === "string"
    && reservation.variantId.length > 0
    && reservation.variantId.length <= 180
    && reservation.pool === "regular"
    && Number.isSafeInteger(reservation.quantity)
    && reservation.quantity > 0
  );
}

function preferredLane(requestHash: string): number {
  let hash = 0;
  for (let index = 0; index < requestHash.length; index += 1) {
    hash = ((hash * 33) ^ requestHash.charCodeAt(index)) >>> 0;
  }
  return hash % CHECKOUT_RESERVATION_LANE_COUNT;
}

function cloneLaneState(state: ReservationLaneState): ReservationLaneState {
  return { ...state };
}

function parseResponsePayload(payload: string): JsonObject | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCheckoutAuthorityChangedError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.toUpperCase().includes("CHECKOUT_AUTHORITY_CHANGED")) return true;
    current = current instanceof Error
      ? (current as Error & { cause?: unknown }).cause
      : null;
  }
  return false;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Stateful optimization around database authority. Every cache entry is
 * reconstructed from the database on cold start and discarded after any
 * uncertain result; no Durable Object storage fact is required for recovery.
 */
export class CheckoutCoordinatorEngine {
  private readonly pending: PendingCheckout[] = [];
  private readonly activeByRequestKey = new Map<string, PendingCheckout>();
  private readonly committedByRequestKey = new Map<string, {
    requestHash: string;
    orderId: string;
    response: JsonObject;
  }>();
  private readonly laneStates = new Map<string, ReservationLaneState>();
  private readonly inFlightLanes = new Set<number>();
  private readonly pendingProjections: PendingCheckoutProjection[] = [];
  private drainRunning = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private projectionDrain: Promise<void> | null = null;

  constructor(
    private readonly transport: CheckoutSqlTransport,
    private readonly waitUntil: (task: Promise<unknown>) => void = (task) => {
      void task;
    },
    private readonly sideEffectQueue?: CheckoutSideEffectQueue,
  ) {}

  submit<TPayload extends JsonObject, TResponse extends JsonObject>(
    command: CheckoutCommitCommand<TPayload, TResponse>,
  ): Promise<CheckoutCoordinatorResult> {
    if (!isCheckoutCommand(command)) {
      return Promise.resolve({ ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" });
    }

    const recent = this.committedByRequestKey.get(command.requestKey);
    if (recent) {
      if (recent.requestHash !== command.requestHash) {
        return Promise.resolve({ ok: false, code: "CHECKOUT_IDEMPOTENCY_CONFLICT" });
      }
      return Promise.resolve({
        ok: true,
        orderId: recent.orderId,
        response: recent.response,
        replay: true,
        availabilityChangedSubjects: [],
      });
    }

    const active = this.activeByRequestKey.get(command.requestKey);
    if (active) {
      if (active.command.requestHash !== command.requestHash) {
        return Promise.resolve({ ok: false, code: "CHECKOUT_IDEMPOTENCY_CONFLICT" });
      }
      return new Promise((resolve) => active.resolvers.push(resolve));
    }

    return new Promise((resolve) => {
      const pending: PendingCheckout = {
        command: command as unknown as Command,
        resolvers: [resolve],
        recoveryAttempts: 0,
      };
      this.pending.push(pending);
      this.activeByRequestKey.set(command.requestKey, pending);
      this.scheduleFlush();
    });
  }

  private get maxInFlight(): number {
    return this.transport.provider === "d1" ? 1 : 2;
  }

  get batchLimits(): {
    maxOrders: number;
    maxJsonBytes: number;
    targetOrders: number;
    targetJsonBytes: number;
  } {
    return this.transport.checkoutBatchLimits ?? {
      maxOrders: CHECKOUT_COMMIT_MAX_ORDERS,
      maxJsonBytes: CHECKOUT_COMMIT_MAX_JSON_BYTES,
      targetOrders: TARGET_BATCH_ORDERS,
      targetJsonBytes: TARGET_BATCH_JSON_BYTES,
    };
  }

  get ingressBatchLimits(): { targetOrders: number; targetJsonBytes: number } {
    return {
      targetOrders: this.batchLimits.targetOrders * this.maxInFlight,
      targetJsonBytes: this.batchLimits.targetJsonBytes * this.maxInFlight,
    };
  }

  private scheduleFlush(): void {
    if (this.pending.length === 0) return;
    if (
      this.pending.length >= this.batchLimits.targetOrders * this.maxInFlight
      && this.inFlightLanes.size < this.maxInFlight
    ) {
      if (this.flushTimer !== null) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.waitUntil(this.drain(false));
      return;
    }
    if (this.inFlightLanes.size > 0 || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.waitUntil(this.drain(true));
    }, IDLE_FLUSH_MS);
  }

  private async drain(allowPartial: boolean): Promise<void> {
    if (this.drainRunning) return;
    this.drainRunning = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;

    try {
      if (this.pending.length > 0) {
        await this.ensureLaneStatesForPending();
      }

      while (this.inFlightLanes.size < this.maxInFlight && this.pending.length > 0) {
        const freeLanes = Array.from(
          { length: CHECKOUT_RESERVATION_LANE_COUNT },
          (_, lane) => lane,
        ).filter((lane) => !this.inFlightLanes.has(lane));
        let started = false;
        const permitPartial = allowPartial;
        for (const lane of freeLanes) {
          if (this.inFlightLanes.size >= this.maxInFlight) break;
          const batch = this.prepareLaneBatch(lane, permitPartial);
          if (!batch) continue;
          started = true;
          this.inFlightLanes.add(lane);
          // Optimistic local state lets the other disjoint lane observe the
          // combined pending availability transition. A failed commit drops
          // these entries and reloads database authority before retrying.
          for (const [key, state] of batch.finalStates) this.laneStates.set(key, state);
          const operation = this.commitAndResolve(batch, lane).finally(() => {
            this.inFlightLanes.delete(lane);
            if (this.pending.length > 0) {
              this.waitUntil(this.drain(this.inFlightLanes.size === 0));
            }
          });
          this.waitUntil(operation);
        }
        if (!started && !permitPartial && this.inFlightLanes.size === 0) {
          // A lane can have useful capacity smaller than the target batch
          // (especially the final hot-SKU tail). Commit that bounded partial
          // batch once instead of repeatedly waiting for an impossible full
          // batch while every individual request still appears to fit.
          allowPartial = true;
          continue;
        }
        allowPartial = false;
        if (!started) break;
      }

      if (this.pending.length > 0 && this.inFlightLanes.size === 0) {
        await this.resolveBlockedPending();
      }
    } catch {
      await this.recoverPendingAfterCoordinatorFailure();
    } finally {
      this.drainRunning = false;
      if (this.pending.length > 0) this.scheduleFlush();
    }
  }

  private async ensureLaneStatesForPending(force = false): Promise<void> {
    const variantIds = [...new Set(this.pending.flatMap((pending) =>
      pending.command.reservations.map((reservation) => reservation.variantId)
    ))].filter((variantId) => force || (
      !this.laneStates.has(laneStateKey(variantId, 0))
      || !this.laneStates.has(laneStateKey(variantId, 1))
    ));
    if (variantIds.length === 0) return;

    for (const ids of chunk(variantIds, VARIANT_READ_CHUNK)) {
      await this.transport.atomic([
        buildEnsureCheckoutReservationLanesStatement(ids),
      ]);
      const rows = await this.transport.all<CheckoutReservationLaneSnapshotRow>(
        buildCheckoutReservationLaneSnapshotStatement(ids),
      );
      this.installLaneSnapshot(ids, rows);
    }
  }

  private installLaneSnapshot(
    variantIds: readonly string[],
    rows: readonly CheckoutReservationLaneSnapshotRow[],
  ): void {
    const byVariant = new Map<string, CheckoutReservationLaneSnapshotRow[]>();
    for (const row of rows) {
      const existing = byVariant.get(row.variantId) ?? [];
      existing.push(row);
      byVariant.set(row.variantId, existing);
    }

    for (const variantId of variantIds) {
      const variantRows = byVariant.get(variantId) ?? [];
      if (
        variantRows.length !== CHECKOUT_RESERVATION_LANE_COUNT
        || new Set(variantRows.map((row) => Number(row.lane))).size
          !== CHECKOUT_RESERVATION_LANE_COUNT
      ) {
        throw new Error("Checkout reservation authority is unavailable.");
      }
      const stock = Number(variantRows[0]!.stock);
      const legacyReservedStock = Number(variantRows[0]!.legacyReservedStock);
      const stockVersion = Number(variantRows[0]!.stockVersion);
      const totalCapacity = variantRows.reduce((sum, row) => sum + Number(row.capacity), 0);
      const totalLaneReserved = variantRows.reduce(
        (sum, row) => sum + Number(row.reservedQuantity),
        0,
      );
      if (
        !Number.isSafeInteger(stock)
        || stock < 0
        || !Number.isSafeInteger(legacyReservedStock)
        || legacyReservedStock < 0
        || !Number.isSafeInteger(stockVersion)
        || stockVersion < 1
        || totalCapacity !== Math.max(
          totalLaneReserved,
          Math.max(0, stock - legacyReservedStock),
        )
        || variantRows.some((row) =>
          row.trackInventory !== true
          && Number(row.trackInventory) !== 1
          || !Number.isSafeInteger(Number(row.lane))
          || Number(row.lane) < 0
          || Number(row.lane) >= CHECKOUT_RESERVATION_LANE_COUNT
          || !Number.isSafeInteger(Number(row.capacity))
          || Number(row.capacity) < 0
          || !Number.isSafeInteger(Number(row.reservedQuantity))
          || Number(row.reservedQuantity) < 0
          || Number(row.reservedQuantity) > Number(row.capacity)
          || !Number.isSafeInteger(Number(row.laneVersion))
          || Number(row.laneVersion) < 0
          || Number(row.sourceStockVersion) !== stockVersion
        )
      ) {
        throw new Error("Checkout reservation authority failed its capacity invariant.");
      }

      for (const row of variantRows) {
        const lane = Number(row.lane);
        this.laneStates.set(laneStateKey(variantId, lane), {
          variantId,
          productId: row.productId,
          productSlug: row.productSlug,
          categoryId: row.categoryId,
          lane,
          capacity: Number(row.capacity),
          reservedQuantity: Number(row.reservedQuantity),
          laneVersion: Number(row.laneVersion),
          sourceStockVersion: Number(row.sourceStockVersion),
          stock,
          legacyReservedStock,
        });
      }
    }
  }

  private canFit(
    command: Command,
    lane: number,
    states: ReadonlyMap<string, ReservationLaneState> = this.laneStates,
  ): boolean {
    return command.reservations.every((reservation) => {
      const state = states.get(laneStateKey(reservation.variantId, lane));
      return Boolean(
        state
        && state.capacity - state.reservedQuantity >= reservation.quantity,
      );
    });
  }

  private canFitAcrossLanes(command: Command): boolean {
    return command.reservations.every((reservation) => {
      const lane0 = this.laneStates.get(laneStateKey(reservation.variantId, 0));
      const lane1 = this.laneStates.get(laneStateKey(reservation.variantId, 1));
      return Boolean(
        lane0
        && lane1
        && (lane0.capacity - lane0.reservedQuantity)
          + (lane1.capacity - lane1.reservedQuantity) >= reservation.quantity,
      );
    });
  }

  private async rebalanceOneBlockedPending(): Promise<boolean> {
    for (const pending of this.pending) {
      if (
        this.canFit(pending.command, 0)
        || this.canFit(pending.command, 1)
        || !this.canFitAcrossLanes(pending.command)
      ) {
        continue;
      }

      const targetLane = preferredLane(pending.command.requestHash);
      const quantities = new Map<string, number>();
      for (const reservation of pending.command.reservations) {
        quantities.set(
          reservation.variantId,
          (quantities.get(reservation.variantId) ?? 0) + reservation.quantity,
        );
      }
      const changes: CheckoutReservationLaneRebalance[] = [];
      for (const [variantId, quantity] of quantities) {
        const lane0 = this.laneStates.get(laneStateKey(variantId, 0))!;
        const lane1 = this.laneStates.get(laneStateKey(variantId, 1))!;
        const target = targetLane === 0 ? lane0 : lane1;
        if (target.capacity - target.reservedQuantity >= quantity) continue;
        changes.push({
          variantId,
          targetLane,
          sourceStockVersion: lane0.sourceStockVersion,
          lanes: [{
            capacity: lane0.capacity,
            reservedQuantity: lane0.reservedQuantity,
            laneVersion: lane0.laneVersion,
          }, {
            capacity: lane1.capacity,
            reservedQuantity: lane1.reservedQuantity,
            laneVersion: lane1.laneVersion,
          }],
        });
      }
      if (changes.length === 0) continue;

      await this.transport.atomic(
        buildRebalanceCheckoutReservationLanesStatements(changes),
      );
      for (const change of changes) {
        this.laneStates.delete(laneStateKey(change.variantId, 0));
        this.laneStates.delete(laneStateKey(change.variantId, 1));
      }
      await this.ensureLaneStatesForPending(true);
      if (!this.canFit(pending.command, targetLane)) {
        throw new Error("Checkout reservation rebalance did not expose expected capacity.");
      }
      return true;
    }
    return false;
  }

  private prepareLaneBatch(lane: number, allowPartial: boolean): PreparedLaneBatch | null {
    const localStates = new Map<string, ReservationLaneState>();
    for (const [key, state] of this.laneStates) localStates.set(key, cloneLaneState(state));
    const selected: PendingCheckout[] = [];
    const commits: PreparedCheckoutCommit<JsonObject, JsonObject>[] = [];
    const selectedIndexes: number[] = [];
    let estimatedBytes = 2;
    let selectedAuthorityRevision: number | null = null;

    for (const [index, pending] of this.pending.entries()) {
      if (selected.length >= this.batchLimits.maxOrders) break;
      const preferred = preferredLane(pending.command.requestHash);
      const fitsLane = this.canFit(pending.command, lane, localStates);
      if (!fitsLane) continue;
      if (
        preferred !== lane
        && this.maxInFlight > 1
        && this.canFit(pending.command, preferred, this.laneStates)
        && !this.inFlightLanes.has(preferred)
      ) {
        continue;
      }
      if (
        selectedAuthorityRevision !== null
        && pending.command.authorityRevision !== selectedAuthorityRevision
      ) {
        continue;
      }
      selectedAuthorityRevision ??= pending.command.authorityRevision;

      const edges: CheckoutReservationEdge[] = pending.command.reservations.map((reservation) => {
        const key = laneStateKey(reservation.variantId, lane);
        const state = localStates.get(key)!;
        const edge: CheckoutReservationEdge = {
          variantId: reservation.variantId,
          pool: "regular",
          lane,
          quantity: reservation.quantity,
          capacity: state.capacity,
          reservedBefore: state.reservedQuantity,
          reservedAfter: state.reservedQuantity + reservation.quantity,
          laneVersionBefore: state.laneVersion,
          laneVersionAfter: state.laneVersion + 1,
          sourceStockVersion: state.sourceStockVersion,
        };
        state.reservedQuantity = edge.reservedAfter;
        state.laneVersion = edge.laneVersionAfter;
        return edge;
      });
      const prepared: PreparedCheckoutCommit<JsonObject, JsonObject> = {
        ...pending.command,
        lane,
        edges,
      };
      const commandBytes = new TextEncoder().encode(JSON.stringify({
        aggregate: prepared.aggregate,
        edges: prepared.edges,
      })).byteLength + 1;
      if (
        selected.length > 0
        && estimatedBytes + commandBytes > this.batchLimits.targetJsonBytes
      ) {
        // Undo this candidate's local counters; it will be picked up by the
        // next batch without changing the shared authority cache.
        for (const edge of edges) {
          const state = localStates.get(laneStateKey(edge.variantId, lane))!;
          state.reservedQuantity = edge.reservedBefore;
          state.laneVersion = edge.laneVersionBefore;
        }
        break;
      }
      selected.push(pending);
      commits.push(prepared);
      selectedIndexes.push(index);
      estimatedBytes += commandBytes;
    }

    if (selected.length === 0) return null;
    const full = selected.length >= this.batchLimits.targetOrders
      || estimatedBytes >= this.batchLimits.targetJsonBytes
      || estimatedBytes >= this.batchLimits.maxJsonBytes * 0.9;
    if (!allowPartial && !full) return null;

    for (let offset = selectedIndexes.length - 1; offset >= 0; offset -= 1) {
      this.pending.splice(selectedIndexes[offset]!, 1);
    }

    const availabilityChangedSubjects = new Map<string, {
      productId: string;
      slug: string | null;
      categoryId: string | null;
    }>();
    for (const commit of commits) {
      for (const edge of commit.edges) {
        const beforeLane = this.laneStates.get(laneStateKey(edge.variantId, lane))!;
        const beforeReserved = Array.from(
          { length: CHECKOUT_RESERVATION_LANE_COUNT },
          (_, candidateLane) => this.laneStates.get(
            laneStateKey(edge.variantId, candidateLane),
          )?.reservedQuantity ?? 0,
        ).reduce((sum, value) => sum + value, 0);
        const afterReserved = Array.from(
          { length: CHECKOUT_RESERVATION_LANE_COUNT },
          (_, candidateLane) => localStates.get(
            laneStateKey(edge.variantId, candidateLane),
          )?.reservedQuantity ?? 0,
        ).reduce((sum, value) => sum + value, 0);
        const sellableCapacity = Math.max(0, beforeLane.stock - beforeLane.legacyReservedStock);
        if (beforeReserved < sellableCapacity && afterReserved >= sellableCapacity) {
          availabilityChangedSubjects.set(beforeLane.productId, {
            productId: beforeLane.productId,
            slug: beforeLane.productSlug,
            categoryId: beforeLane.categoryId,
          });
        }
      }
    }

    const finalStates = new Map<string, ReservationLaneState>();
    for (const commit of commits) {
      for (const edge of commit.edges) {
        const key = laneStateKey(edge.variantId, lane);
        finalStates.set(key, cloneLaneState(localStates.get(key)!));
      }
    }
    return {
      pending: selected,
      commits,
      finalStates,
      availabilityChangedSubjects: [...availabilityChangedSubjects.values()],
    };
  }

  private async commitAndResolve(batch: PreparedLaneBatch, lane: number): Promise<void> {
    try {
      const outboxId = `cbo_${crypto.randomUUID()}`;
      await this.transport.atomic(
        buildCheckoutCommitStatements(
          batch.commits,
          outboxId,
          this.batchLimits,
        ),
        lane,
      );
      // The immutable order/stock authority is now durable. Projection is a
      // deterministic read model and is grouped after the ingress burst so it
      // cannot serialize every buyer response behind another write batch. A
      // failure leaves the durable outbox pending for scheduled recovery.
      this.pendingProjections.push({
        outboxId,
        orderCount: batch.commits.length,
        queuedAt: Date.now(),
        sideEffectMessages: batch.commits.flatMap((commit) => {
          const projection = commit.aggregate.projection;
          if (!projection) return [];
          const messages: CheckoutSideEffectQueueMessage[] = [];
          if (projection.notificationOutboxId) {
            messages.push({
              type: "order.notification",
              outboxId: projection.notificationOutboxId,
              orderId: commit.order.id,
              customerEmail: commit.order.customerEmail ?? undefined,
              customerName: commit.order.customerName || "Customer",
              notificationType: "order_created",
            });
          }
          if (projection.metaPurchaseOutboxId) {
            messages.push({
              type: "meta.purchase",
              orderId: commit.order.id,
              source: "storefront-checkout-aggregate",
            });
          }
          return messages;
        }),
      });
      for (const pending of batch.pending) {
        this.resolveSuccess(
          pending,
          pending.command.response,
          false,
          batch.availabilityChangedSubjects,
        );
      }
    } catch (error) {
      if (isCheckoutAuthorityChangedError(error)) {
        for (const pending of batch.pending) this.resolveAuthorityChanged(pending);
        for (const commit of batch.commits) {
          for (const edge of commit.edges) {
            for (let candidateLane = 0; candidateLane < CHECKOUT_RESERVATION_LANE_COUNT; candidateLane += 1) {
              this.laneStates.delete(laneStateKey(edge.variantId, candidateLane));
            }
          }
        }
        return;
      }
      await this.recoverBatch(batch, lane);
    }
  }

  /**
   * Flush read-model work after durable checkout acknowledgements. Concurrent
   * callers share one drain, and several commit outboxes use one fixed SQL
   * statement set. This does not participate in checkout success authority.
   */
  flushPendingProjections(): Promise<void> {
    if (this.projectionDrain) return this.projectionDrain;
    if (this.pendingProjections.length === 0) return Promise.resolve();

    const drain = this.drainPendingProjections().finally(() => {
      this.projectionDrain = null;
      if (this.pendingProjections.length > 0) {
        this.waitUntil(this.flushPendingProjections());
      }
    });
    this.projectionDrain = drain;
    return drain;
  }

  shouldFlushPendingProjections(now = Date.now()): boolean {
    if (this.pendingProjections.length === 0 || this.projectionDrain) return false;
    const deferredOrders = this.pendingProjections.reduce(
      (sum, candidate) => sum + candidate.orderCount,
      0,
    );
    return deferredOrders >= CHECKOUT_PROJECTION_MAX_DEFERRED_ORDERS
      || now - this.pendingProjections[0]!.queuedAt >= CHECKOUT_PROJECTION_MAX_DEFER_MS;
  }

  private takeProjectionBatch(): PendingCheckoutProjection[] {
    const selected: PendingCheckoutProjection[] = [];
    let orderCount = 0;
    while (
      this.pendingProjections.length > 0
      && selected.length < CHECKOUT_PROJECTION_MAX_OUTBOXES
    ) {
      const candidate = this.pendingProjections[0]!;
      if (
        selected.length > 0
        && orderCount + candidate.orderCount > CHECKOUT_PROJECTION_MAX_ORDERS
      ) {
        break;
      }
      this.pendingProjections.shift();
      selected.push(candidate);
      orderCount += candidate.orderCount;
    }
    return selected;
  }

  private async drainPendingProjections(): Promise<void> {
    while (this.pendingProjections.length > 0) {
      const selected = this.takeProjectionBatch();
      if (selected.length === 0) return;
      try {
        await this.transport.atomic(
          buildCheckoutProjectionBatchStatements(
            selected.map((candidate) => candidate.outboxId),
          ),
        );
      } catch {
        continue;
      }

      await this.relayProjectionSideEffects(selected).catch(() => {
        // Projection committed both durable outboxes. A queue outage therefore
        // leaves retryable database authority for the scheduled sweep without
        // changing the already-acknowledged checkout result.
      });
    }
  }

  private async relayProjectionSideEffects(
    projected: readonly PendingCheckoutProjection[],
  ): Promise<void> {
    if (!this.sideEffectQueue) return;
    const messages = projected.flatMap((candidate) => candidate.sideEffectMessages);
    for (const batch of chunk(messages, CHECKOUT_SIDE_EFFECT_QUEUE_BATCH_SIZE)) {
      await this.sideEffectQueue.sendBatch(
        batch.map((body) => ({ body })),
        { delaySeconds: CHECKOUT_SIDE_EFFECT_QUEUE_DELAY_SECONDS },
      );
    }
  }

  private async recoverBatch(batch: PreparedLaneBatch, lane: number): Promise<void> {
    let existing: Map<string, ExistingCheckoutIdentityRow> | null = null;
    try {
      existing = await this.loadExistingIdentities(batch.pending, lane);
    } catch {
      // A bounded retry below will still resynchronize database authority.
    }

    const unresolved: PendingCheckout[] = [];
    for (const pending of batch.pending) {
      const row = existing?.get(pending.command.requestKey);
      if (!row) {
        unresolved.push(pending);
        continue;
      }
      if (
        row.requestHash !== pending.command.requestHash
      ) {
        this.resolveConflict(pending);
        continue;
      }
      const response = parseResponsePayload(row.responsePayload);
      if (!response) {
        this.resolveFailure(pending);
        continue;
      }
      this.resolveSuccess(pending, response, true, [], row.orderId);
    }

    const affectedVariantIds = [...new Set(batch.commits.flatMap((commit) =>
      commit.edges.map((edge) => edge.variantId)
    ))];
    for (const variantId of affectedVariantIds) {
      for (let candidateLane = 0; candidateLane < CHECKOUT_RESERVATION_LANE_COUNT; candidateLane += 1) {
        this.laneStates.delete(laneStateKey(variantId, candidateLane));
      }
    }

    if (unresolved.length === 0) return;
    const retryable: PendingCheckout[] = [];
    for (const pending of unresolved) {
      if (pending.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        pending.recoveryAttempts += 1;
        retryable.push(pending);
      } else {
        this.resolveFailure(pending);
      }
    }
    if (retryable.length > 0) this.pending.unshift(...retryable);
  }

  private async loadExistingIdentities(
    pending: readonly PendingCheckout[],
    slot = 0,
  ): Promise<Map<string, ExistingCheckoutIdentityRow>> {
    const rows = await this.transport.all<ExistingCheckoutIdentityRow>(
      buildExistingCheckoutIdentityStatement(
        pending.map((candidate) => candidate.command.requestKey),
        this.batchLimits.maxOrders,
      ),
      slot,
    );
    return new Map(rows.map((row) => [row.requestKey, row]));
  }

  private async resolveBlockedPending(): Promise<void> {
    const blocked = [...this.pending];
    if (blocked.length === 0) return;
    let existing: Map<string, ExistingCheckoutIdentityRow>;
    try {
      existing = await this.loadExistingIdentities(blocked);
    } catch {
      for (const pending of blocked) this.removeAndResolveFailure(pending);
      return;
    }

    for (const pending of blocked) {
      const row = existing.get(pending.command.requestKey);
      if (!row) continue;
      this.removePending(pending);
      if (
        row.requestHash !== pending.command.requestHash
      ) {
        this.resolveConflict(pending);
      } else {
        const response = parseResponsePayload(row.responsePayload);
        if (response) this.resolveSuccess(pending, response, true, [], row.orderId);
        else this.resolveFailure(pending);
      }
    }

    const remaining = [...this.pending];
    if (remaining.length === 0) return;
    const variantIds = [...new Set(remaining.flatMap((pending) =>
      pending.command.reservations.map((reservation) => reservation.variantId)
    ))];
    for (const variantId of variantIds) {
      for (let lane = 0; lane < CHECKOUT_RESERVATION_LANE_COUNT; lane += 1) {
        this.laneStates.delete(laneStateKey(variantId, lane));
      }
    }
    try {
      await this.ensureLaneStatesForPending(true);
    } catch {
      for (const pending of remaining) this.removeAndResolveFailure(pending);
      return;
    }

    try {
      if (await this.rebalanceOneBlockedPending()) return;
    } catch {
      for (const pending of remaining) this.removeAndResolveFailure(pending);
      return;
    }

    for (const pending of [...this.pending]) {
      if (
        this.canFit(pending.command, 0)
        || this.canFit(pending.command, 1)
      ) {
        continue;
      }
      this.removePending(pending);
      this.resolveUnavailable(pending);
    }
  }

  private async recoverPendingAfterCoordinatorFailure(): Promise<void> {
    const pending = [...this.pending];
    if (pending.length === 0) return;
    try {
      const existing = await this.loadExistingIdentities(pending);
      for (const candidate of pending) {
        const row = existing.get(candidate.command.requestKey);
        if (!row) {
          this.removeAndResolveFailure(candidate);
          continue;
        }
        this.removePending(candidate);
        if (
          row.requestHash !== candidate.command.requestHash
        ) {
          this.resolveConflict(candidate);
          continue;
        }
        const response = parseResponsePayload(row.responsePayload);
        if (response) this.resolveSuccess(candidate, response, true, [], row.orderId);
        else this.resolveFailure(candidate);
      }
    } catch {
      for (const candidate of pending) this.removeAndResolveFailure(candidate);
    }
  }

  private rememberCommitted(
    pending: PendingCheckout,
    response: JsonObject,
    orderId = pending.command.order.id,
  ): void {
    this.committedByRequestKey.delete(pending.command.requestKey);
    this.committedByRequestKey.set(pending.command.requestKey, {
      requestHash: pending.command.requestHash,
      orderId,
      response,
    });
    while (this.committedByRequestKey.size > MAX_RECENT_COMMITS) {
      const oldest = this.committedByRequestKey.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.committedByRequestKey.delete(oldest);
    }
  }

  private resolveSuccess(
    pending: PendingCheckout,
    response: JsonObject,
    replay: boolean,
    availabilityChangedSubjects: Array<{
      productId: string;
      slug: string | null;
      categoryId: string | null;
    }>,
    orderId = pending.command.order.id,
  ): void {
    this.activeByRequestKey.delete(pending.command.requestKey);
    this.rememberCommitted(pending, response, orderId);
    const result: CheckoutCoordinatorResult = {
      ok: true,
      orderId,
      response,
      replay,
      availabilityChangedSubjects,
    };
    for (const resolve of pending.resolvers) resolve(result);
  }

  private resolveConflict(pending: PendingCheckout): void {
    this.activeByRequestKey.delete(pending.command.requestKey);
    for (const resolve of pending.resolvers) {
      resolve({ ok: false, code: "CHECKOUT_IDEMPOTENCY_CONFLICT" });
    }
  }

  private resolveUnavailable(pending: PendingCheckout): void {
    this.activeByRequestKey.delete(pending.command.requestKey);
    for (const resolve of pending.resolvers) {
      resolve({ ok: false, code: "CHECKOUT_INVENTORY_UNAVAILABLE" });
    }
  }

  private resolveAuthorityChanged(pending: PendingCheckout): void {
    this.activeByRequestKey.delete(pending.command.requestKey);
    for (const resolve of pending.resolvers) {
      resolve({ ok: false, code: "CHECKOUT_AUTHORITY_CHANGED" });
    }
  }

  private resolveFailure(pending: PendingCheckout): void {
    this.activeByRequestKey.delete(pending.command.requestKey);
    for (const resolve of pending.resolvers) {
      resolve({ ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" });
    }
  }

  private removePending(pending: PendingCheckout): void {
    const index = this.pending.indexOf(pending);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private removeAndResolveFailure(pending: PendingCheckout): void {
    this.removePending(pending);
    this.resolveFailure(pending);
  }
}

function isCheckoutIntentCommand(value: unknown): value is CheckoutIntentCommand {
  if (!isJsonObject(value) || !isJsonObject(value.attempt) || !isJsonObject(value.data)) {
    return false;
  }
  const attempt = value.attempt;
  const data = value.data;
  if (
    attempt.commitMode !== "atomic"
    || (attempt.origin !== "new" && attempt.origin !== "retry")
    || typeof attempt.id !== "string"
    || typeof attempt.requestKey !== "string"
    || typeof attempt.requestHash !== "string"
    || typeof attempt.orderId !== "string"
    || typeof attempt.checkoutToken !== "string"
    || typeof attempt.statusToken !== "string"
    || attempt.id.length > 180
    || attempt.requestKey.length > 320
    || attempt.requestHash.length > 320
    || attempt.orderId.length > 180
    || attempt.checkoutToken.length > 320
    || attempt.statusToken.length > 320
  ) {
    return false;
  }
  if (
    typeof value.requestUrl !== "string"
    || value.requestUrl.length > 4_096
    || data.paymentMethod !== "cod"
    || data.inventoryPool !== "regular"
    || (typeof data.discountCode === "string" && data.discountCode.trim().length > 0)
    || !Array.isArray(data.items)
    || data.items.length < 1
    || data.items.length > 99
  ) {
    return false;
  }
  try {
    const requestUrl = new URL(value.requestUrl);
    if (requestUrl.protocol !== "https:" && requestUrl.protocol !== "http:") return false;
  } catch {
    return false;
  }
  return data.items.every((item) =>
    isJsonObject(item)
    && typeof item.productId === "string"
    && item.productId.length > 0
    && item.productId.length <= 180
    && typeof item.variantId === "string"
    && item.variantId.length > 0
    && item.variantId.length <= 180
    && Number.isSafeInteger(item.quantity)
    && Number(item.quantity) > 0
    && Number(item.quantity) <= 99
    && typeof item.price === "number"
    && Number.isFinite(item.price)
  );
}

function checkoutIntentAuthorityInput(command: CheckoutIntentCommand) {
  const data = command.data;
  return {
    items: data.items.map((item) => ({
      cartKey: item.cartKey,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
      productName: item.productName,
      variantLabel: item.variantLabel,
    })),
    inventoryPool: data.inventoryPool,
    inventoryAuthority: "coordinator" as const,
    city: data.city,
    zone: data.zone,
    area: data.area,
    shippingMethodId: data.shippingMethodId,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
  };
}

function checkoutAuthorityCacheKey(
  inputs: readonly ReturnType<typeof checkoutIntentAuthorityInput>[],
): string {
  const uniqueSorted = (values: readonly (string | null | undefined)[]) =>
    [...new Set(values.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ))].sort();
  return JSON.stringify({
    products: uniqueSorted(inputs.flatMap((input) =>
      input.items.map((item) => item.productId)
    )),
    variants: uniqueSorted(inputs.flatMap((input) =>
      input.items.map((item) => item.variantId)
    )),
    locations: uniqueSorted(inputs.flatMap((input) => [
      input.city,
      input.zone,
      input.area,
    ])),
    shippingMethods: uniqueSorted(inputs.map((input) => input.shippingMethodId)),
  });
}

function checkoutRejected(error: unknown): CheckoutIntentCoordinatorResult {
  if (error instanceof AppError) {
    return {
      ok: false,
      code: "CHECKOUT_REJECTED",
      status: error.status,
      errorCode: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
}

async function prepareCheckoutIntent(
  db: Database,
  pending: PendingCheckoutIntent,
  authorityResolution: Awaited<ReturnType<
    ReturnType<typeof createStorefrontCheckoutAuthorityBatchReadPlan>["resolveSettled"]
  >>[number],
  onInternalError?: (phase: "authority" | "prepare" | "batch", error: unknown) => void,
): Promise<
  | { ok: true; pending: PendingCheckoutIntent; payload: StorefrontOrderCommitPayload; command: Command }
  | { ok: false; pending: PendingCheckoutIntent; result: CheckoutIntentCoordinatorResult }
> {
  if (!authorityResolution.ok) {
    onInternalError?.("authority", authorityResolution.error);
    return {
      ok: false,
      pending,
      result: checkoutRejected(authorityResolution.error),
    };
  }
  try {
    const authority = authorityResolution.snapshot;
    const checkoutSettings = assertGuestStorefrontCheckoutPolicy(
      pending.command.data.customerPhone,
      "cod",
      authority,
    );
    const result = await createStorefrontOrder(
      db,
      pending.command.data,
      pending.command.requestUrl,
      async () => {
        throw new Error("Discount evaluation is outside coordinated checkout version 1.");
      },
      () => {
        throw new Error("Discount calculation is outside coordinated checkout version 1.");
      },
      {
        orderId: pending.command.attempt.orderId,
        checkoutToken: pending.command.attempt.checkoutToken,
      },
      authority.cartValidation,
      authority.deliveryPreflight,
      undefined,
      {
        code: authority.currency.currencyCode,
        decimalPlaces: getDecimalPlaces(authority.currency.currencyCode),
      },
      undefined,
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        authorityRevision: authority.authorityRevision,
        orderCreatedNotificationEnabled:
          authority.sideEffects.orderCreatedNotification,
        metaPurchaseEnabled: authority.sideEffects.metaPurchase,
      }),
      authority.taxAuthority,
    );
    const response = {
      checkoutToken: result.checkoutToken,
      receiptToken: result.checkoutToken,
      statusToken: pending.command.attempt.statusToken,
      orderId: result.orderId,
      paymentMethod: result.paymentMethod,
      totalAmount: result.totalAmount,
      totalAmountMinor: result.taxQuote.totalMinor,
      taxAmount: fromMinorUnits(result.taxQuote.taxMinor, result.taxQuote.decimalPlaces),
      taxAmountMinor: result.taxQuote.taxMinor,
      taxLabel: result.taxQuote.displayLabel,
      pricesIncludeTax: result.taxQuote.pricesIncludeTax,
      currencyCode: result.taxQuote.currencyCode,
      decimalPlaces: result.taxQuote.decimalPlaces,
      message: "Order created",
    };
    const command = await prepareCheckoutCommitCommand(
      result.commitPayload,
      pending.command.attempt,
      response,
    );
    return {
      ok: true,
      pending,
      payload: result.commitPayload,
      command: command as unknown as Command,
    };
  } catch (error) {
    onInternalError?.("prepare", error);
    return { ok: false, pending, result: checkoutRejected(error) };
  }
}

/**
 * Ingress stage for the common guest COD path. It converts a burst of raw
 * checkout intents into one shared authority read, then hands independently
 * validated immutable commands to the existing atomic commit engine.
 */
export class CheckoutIntentCoordinatorEngine {
  private readonly pending: PendingCheckoutIntent[] = [];
  private readonly activeByRequestKey = new Map<string, PendingCheckoutIntent>();
  private readonly authorityCache = new Map<string, CheckoutAuthorityCacheEntry>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private drainRunning = false;

  constructor(
    private readonly db: Database,
    private readonly credentialEncryptionKey: string | undefined,
    private readonly commitEngine: CheckoutCoordinatorEngine,
    private readonly waitUntil: (task: Promise<unknown>) => void = (task) => {
      void task;
    },
    private readonly onInternalError?: (
      phase: "authority" | "prepare" | "batch",
      error: unknown,
    ) => void,
  ) {}

  submit(command: CheckoutIntentCommand): Promise<CheckoutIntentCoordinatorResult> {
    if (!isCheckoutIntentCommand(command)) {
      return Promise.resolve({ ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" });
    }
    const active = this.activeByRequestKey.get(command.attempt.requestKey);
    if (active) {
      if (active.command.attempt.requestHash !== command.attempt.requestHash) {
        return Promise.resolve({ ok: false, code: "CHECKOUT_IDEMPOTENCY_CONFLICT" });
      }
      return new Promise((resolve) => active.resolvers.push(resolve));
    }

    return new Promise((resolve) => {
      const pending = { command, resolvers: [resolve] };
      this.pending.push(pending);
      this.activeByRequestKey.set(command.attempt.requestKey, pending);
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.pending.length === 0 || this.flushTimer !== null || this.drainRunning) return;
    if (this.pending.length >= this.commitEngine.ingressBatchLimits.targetOrders) {
      this.waitUntil(this.drain());
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.waitUntil(this.drain());
    }, IDLE_FLUSH_MS);
  }

  private takeBatch(): PendingCheckoutIntent[] {
    const selected: PendingCheckoutIntent[] = [];
    let estimatedBytes = 2;
    while (
      this.pending.length > 0
      && selected.length < this.commitEngine.ingressBatchLimits.targetOrders
    ) {
      const candidate = this.pending[0]!;
      const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate.command)).byteLength + 1;
      if (
        selected.length > 0
        && estimatedBytes + candidateBytes
          > this.commitEngine.ingressBatchLimits.targetJsonBytes
      ) break;
      this.pending.shift();
      selected.push(candidate);
      estimatedBytes += candidateBytes;
    }
    return selected;
  }

  private async drain(): Promise<void> {
    if (this.drainRunning) return;
    this.drainRunning = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    try {
      while (true) {
        if (this.pending.length === 0) {
          // Keep one burst drain open across the small gaps between Worker
          // deliveries. Buyer promises have already resolved; this only lets
          // later arrivals share deferred projection work instead of racing it.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, INGRESS_QUIET_FLUSH_MS);
          });
          if (this.pending.length === 0) break;
        }
        await this.processBatch(this.takeBatch());
      }
    } finally {
      this.drainRunning = false;
      if (this.pending.length > 0) this.scheduleFlush();
      else this.waitUntil(this.commitEngine.flushPendingProjections());
    }
  }

  private async processBatch(batch: PendingCheckoutIntent[]): Promise<void> {
    if (batch.length === 0) return;
    try {
      const authorityInputs = batch.map((pending) =>
        checkoutIntentAuthorityInput(pending.command)
      );
      const plan = createStorefrontCheckoutAuthorityBatchReadPlan(
        this.db,
        authorityInputs,
        this.commitEngine.ingressBatchLimits.targetOrders,
      );
      const cacheKey = checkoutAuthorityCacheKey(authorityInputs);
      const now = Date.now();
      const cached = this.authorityCache.get(cacheKey);
      let rawResults: readonly unknown[];
      if (cached && cached.expiresAt > now) {
        this.authorityCache.delete(cacheKey);
        this.authorityCache.set(cacheKey, cached);
        rawResults = cached.results;
      } else {
        if (cached) this.authorityCache.delete(cacheKey);
        rawResults = await this.db.batch(plan.statements as never) as unknown[];
        this.authorityCache.set(cacheKey, {
          expiresAt: now + AUTHORITY_CACHE_TTL_MS,
          results: rawResults,
        });
        while (this.authorityCache.size > AUTHORITY_CACHE_MAX_ENTRIES) {
          const oldest = this.authorityCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.authorityCache.delete(oldest);
        }
      }
      const authority = await plan.resolveSettled(
        rawResults,
        this.credentialEncryptionKey,
      );
      const prepared = await Promise.all(batch.map((pending, index) =>
        prepareCheckoutIntent(
          this.db,
          pending,
          authority[index]!,
          this.onInternalError,
        )
      ));
      const committable = prepared.filter((candidate) => candidate.ok);
      const commitResults = await Promise.all(
        committable.map((candidate) => this.commitEngine.submit(candidate.command)),
      );
      if (commitResults.some((result) =>
        !result.ok && result.code === "CHECKOUT_AUTHORITY_CHANGED"
      )) {
        this.authorityCache.clear();
      }
      let commitIndex = 0;
      for (const candidate of prepared) {
        if (!candidate.ok) {
          this.resolve(candidate.pending, candidate.result);
          continue;
        }
        const result = commitResults[commitIndex++]!;
        this.resolve(candidate.pending, result.ok ? {
          ...result,
          // Projection already creates the durable notification and Meta
          // outboxes. Returning the multi-kilobyte payload to every ingress
          // Worker would duplicate those writes and contend with later commits.
          postCommitPayload: null,
        } : result);
      }
      // Projection is durable and recoverable from checkout_batch_outbox.
      // Drain it only after this ingress burst goes quiet (the drain finally
      // block below), so compatibility/read-model work cannot steal writer
      // capacity from buyer acknowledgements during a sustained spike.
    } catch (error) {
      this.onInternalError?.("batch", error);
      for (const pending of batch) {
        this.resolve(pending, { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" });
      }
    }
  }

  private resolve(
    pending: PendingCheckoutIntent,
    result: CheckoutIntentCoordinatorResult,
  ): void {
    this.activeByRequestKey.delete(pending.command.attempt.requestKey);
    for (const resolve of pending.resolvers) resolve(result);
  }
}

function coordinatorResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export class CheckoutCoordinator {
  private readonly engine: CheckoutCoordinatorEngine;
  private readonly intentEngine: CheckoutIntentCoordinatorEngine;

  constructor(state: DurableObjectState, env: Env) {
    const waitUntil = (task: Promise<unknown>) => state.waitUntil(task);
    this.engine = new CheckoutCoordinatorEngine(
      createCheckoutSqlTransport(env),
      waitUntil,
      env.ORDER_NOTIFICATIONS_QUEUE as unknown as CheckoutSideEffectQueue,
    );
    this.intentEngine = new CheckoutIntentCoordinatorEngine(
      getDb(env),
      getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
      this.engine,
      waitUntil,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST" || (pathname !== "/commit" && pathname !== "/checkout-intent")) {
      return coordinatorResponse({ ok: false, build: COORDINATOR_BUILD }, 404);
    }
    let command: unknown;
    try {
      command = await request.json();
    } catch {
      return coordinatorResponse({ ok: false, build: COORDINATOR_BUILD }, 400);
    }
    if (pathname === "/checkout-intent") {
      if (!isCheckoutIntentCommand(command)) {
        return coordinatorResponse({ ok: false, build: COORDINATOR_BUILD }, 400);
      }
      const result = await this.intentEngine.submit(command);
      return coordinatorResponse(
        { ...result, build: COORDINATOR_BUILD },
        result.ok
          ? 201
          : result.code === "CHECKOUT_REJECTED"
            ? result.status
            : result.code === "CHECKOUT_COMMIT_UNAVAILABLE"
              ? 503
              : 409,
      );
    }
    if (!isCheckoutCommand(command)) {
      return coordinatorResponse({ ok: false, build: COORDINATOR_BUILD }, 400);
    }
    const result = await this.engine.submit(command);
    this.engine.flushPendingProjections().catch(() => undefined);
    return coordinatorResponse(
      { ...result, build: COORDINATOR_BUILD },
      result.ok
        ? 201
        : result.code === "CHECKOUT_COMMIT_UNAVAILABLE"
          ? 503
          : 409,
    );
  }
}

function parseAvailabilityChangedSubjects(value: unknown): Array<{
  productId: string;
  slug: string | null;
  categoryId: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (subject): subject is { productId: string; slug: string | null; categoryId: string | null } =>
      isJsonObject(subject)
      && typeof subject.productId === "string"
      && (subject.slug === null || typeof subject.slug === "string")
      && (subject.categoryId === null || typeof subject.categoryId === "string"),
  );
}

export async function submitCheckoutCommitToCoordinator<
  TPayload,
  TResponse,
>(
  namespace: DurableObjectNamespace,
  command: CheckoutCommitCommand<TPayload, TResponse>,
): Promise<CheckoutCoordinatorResult> {
  const id = namespace.idFromName(COORDINATOR_NAME);
  const response = await namespace.get(id).fetch("https://checkout-coordinator.internal/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.json() as unknown;
  if (!isJsonObject(body) || typeof body.ok !== "boolean") {
    return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
  }
  if (body.ok === true) {
    if (
      typeof body.orderId !== "string"
      || !isJsonObject(body.response)
      || typeof body.replay !== "boolean"
      || !Array.isArray(body.availabilityChangedSubjects)
    ) {
      return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
    }
    return {
      ok: true,
      orderId: body.orderId,
      response: body.response,
      replay: body.replay,
      availabilityChangedSubjects: parseAvailabilityChangedSubjects(
        body.availabilityChangedSubjects,
      ),
    };
  }
  if (
    body.code === "CHECKOUT_IDEMPOTENCY_CONFLICT"
    || body.code === "CHECKOUT_AUTHORITY_CHANGED"
    || body.code === "CHECKOUT_INVENTORY_UNAVAILABLE"
    || body.code === "CHECKOUT_COMMIT_UNAVAILABLE"
  ) {
    return { ok: false, code: body.code };
  }
  return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
}

export async function submitCheckoutIntentToCoordinator(
  namespace: DurableObjectNamespace,
  command: CheckoutIntentCommand,
): Promise<CheckoutIntentCoordinatorResult> {
  const id = namespace.idFromName(COORDINATOR_NAME);
  const response = await namespace.get(id).fetch(
    "https://checkout-coordinator.internal/checkout-intent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    },
  );
  const body = await response.json() as unknown;
  if (!isJsonObject(body) || typeof body.ok !== "boolean") {
    return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
  }
  if (body.ok === true) {
    if (
      typeof body.orderId !== "string"
      || !isJsonObject(body.response)
      || typeof body.replay !== "boolean"
      || !Array.isArray(body.availabilityChangedSubjects)
      || (body.postCommitPayload !== null && !isJsonObject(body.postCommitPayload))
    ) {
      return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
    }
    return {
      ok: true,
      orderId: body.orderId,
      response: body.response,
      replay: body.replay,
      availabilityChangedSubjects: parseAvailabilityChangedSubjects(
        body.availabilityChangedSubjects,
      ),
      postCommitPayload: body.postCommitPayload as StorefrontOrderCommitPayload | null,
    };
  }
  if (
    body.code === "CHECKOUT_IDEMPOTENCY_CONFLICT"
    || body.code === "CHECKOUT_AUTHORITY_CHANGED"
    || body.code === "CHECKOUT_INVENTORY_UNAVAILABLE"
    || body.code === "CHECKOUT_COMMIT_UNAVAILABLE"
  ) {
    return { ok: false, code: body.code };
  }
  if (
    body.code === "CHECKOUT_REJECTED"
    && typeof body.status === "number"
    && Number.isInteger(body.status)
    && body.status >= 400
    && body.status <= 599
    && typeof body.errorCode === "string"
    && typeof body.message === "string"
  ) {
    return {
      ok: false,
      code: "CHECKOUT_REJECTED",
      status: body.status,
      errorCode: body.errorCode,
      message: body.message,
      ...(body.details === undefined ? {} : { details: body.details }),
    };
  }
  return { ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" };
}
