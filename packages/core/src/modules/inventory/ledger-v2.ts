export type InventoryLedgerPool = "regular" | "preorder" | "backorder";

export type InventoryCounterState = {
  stock: number;
  reservedStock: number;
  preorderStock: number;
  stockVersion: number;
};

export type InventoryLedgerV2Event = {
  id: string;
  variantId: string;
  orderId?: string | null;
  type: string;
  pool: InventoryLedgerPool;
  reservationGeneration?: number | null;
  stockVersionBefore: number;
  stockVersionAfter: number;
  previousStock: number;
  newStock: number;
  stockDelta: number;
  previousReservedStock: number;
  newReservedStock: number;
  reservedStockDelta: number;
  previousPreorderStock: number;
  newPreorderStock: number;
  preorderStockDelta: number;
};

export type InventoryLedgerV2EdgeFields = Pick<
  InventoryLedgerV2Event,
  | "pool"
  | "reservationGeneration"
  | "stockVersionBefore"
  | "stockVersionAfter"
  | "previousStock"
  | "newStock"
  | "stockDelta"
  | "previousReservedStock"
  | "newReservedStock"
  | "reservedStockDelta"
  | "previousPreorderStock"
  | "newPreorderStock"
  | "preorderStockDelta"
> & { ledgerVersion: 2 };

export class InventoryLedgerDiscontinuityError extends Error {
  constructor(
    message: string,
    readonly eventId: string,
  ) {
    super(message);
    this.name = "InventoryLedgerDiscontinuityError";
  }
}

export function buildInventoryLedgerV2Edge(input: {
  pool: InventoryLedgerPool;
  reservationGeneration?: number | null;
  before: InventoryCounterState;
  after: InventoryCounterState;
}): InventoryLedgerV2EdgeFields {
  const fields: InventoryLedgerV2EdgeFields = {
    ledgerVersion: 2,
    pool: input.pool,
    reservationGeneration: input.reservationGeneration ?? null,
    stockVersionBefore: input.before.stockVersion,
    stockVersionAfter: input.after.stockVersion,
    previousStock: input.before.stock,
    newStock: input.after.stock,
    stockDelta: input.after.stock - input.before.stock,
    previousReservedStock: input.before.reservedStock,
    newReservedStock: input.after.reservedStock,
    reservedStockDelta: input.after.reservedStock - input.before.reservedStock,
    previousPreorderStock: input.before.preorderStock,
    newPreorderStock: input.after.preorderStock,
    preorderStockDelta: input.after.preorderStock - input.before.preorderStock,
  };

  validateInventoryLedgerV2Event({
    id: "ledger-edge",
    variantId: "ledger-edge",
    orderId: null,
    type: "edge",
    ...fields,
  });
  return fields;
}

function assertInteger(value: number, field: string, eventId: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new InventoryLedgerDiscontinuityError(
      `${field} must be a safe integer`,
      eventId,
    );
  }
}

function assertCounterEdge(
  event: InventoryLedgerV2Event,
  field: "stock" | "reservedStock" | "preorderStock",
  previous: number,
  next: number,
  delta: number,
): void {
  assertInteger(previous, `previous ${field}`, event.id);
  assertInteger(next, `new ${field}`, event.id);
  assertInteger(delta, `${field} delta`, event.id);

  if (previous < 0 || next < 0) {
    throw new InventoryLedgerDiscontinuityError(
      `${field} cannot be negative`,
      event.id,
    );
  }
  if (next - previous !== delta) {
    throw new InventoryLedgerDiscontinuityError(
      `${field} delta does not match its before/after values`,
      event.id,
    );
  }
}

export function validateInventoryLedgerV2Event(event: InventoryLedgerV2Event): void {
  if (!event.id || !event.variantId) {
    throw new InventoryLedgerDiscontinuityError(
      "Ledger event requires an id and variant id",
      event.id,
    );
  }

  assertInteger(event.stockVersionBefore, "stockVersionBefore", event.id);
  assertInteger(event.stockVersionAfter, "stockVersionAfter", event.id);
  if (
    event.stockVersionBefore < 0 ||
    event.stockVersionAfter !== event.stockVersionBefore + 1
  ) {
    throw new InventoryLedgerDiscontinuityError(
      "Ledger event must advance stockVersion by exactly one",
      event.id,
    );
  }

  if (
    event.reservationGeneration != null &&
    (!Number.isSafeInteger(event.reservationGeneration) || event.reservationGeneration < 1)
  ) {
    throw new InventoryLedgerDiscontinuityError(
      "Reservation generation must be a positive safe integer",
      event.id,
    );
  }

  assertCounterEdge(
    event,
    "stock",
    event.previousStock,
    event.newStock,
    event.stockDelta,
  );
  assertCounterEdge(
    event,
    "reservedStock",
    event.previousReservedStock,
    event.newReservedStock,
    event.reservedStockDelta,
  );
  assertCounterEdge(
    event,
    "preorderStock",
    event.previousPreorderStock,
    event.newPreorderStock,
    event.preorderStockDelta,
  );
}

export function foldInventoryLedgerV2(
  initial: InventoryCounterState,
  events: readonly InventoryLedgerV2Event[],
): InventoryCounterState {
  const state = { ...initial };

  for (const event of events) {
    validateInventoryLedgerV2Event(event);

    if (
      event.stockVersionBefore !== state.stockVersion ||
      event.previousStock !== state.stock ||
      event.previousReservedStock !== state.reservedStock ||
      event.previousPreorderStock !== state.preorderStock
    ) {
      throw new InventoryLedgerDiscontinuityError(
        "Ledger event does not continue from the current counter snapshot",
        event.id,
      );
    }

    state.stock = event.newStock;
    state.reservedStock = event.newReservedStock;
    state.preorderStock = event.newPreorderStock;
    state.stockVersion = event.stockVersionAfter;
  }

  return state;
}

export type ReservationGenerationBalance = {
  generation: number;
  reserved: number;
  consumed: number;
  outstanding: number;
};

export function getReservationGenerationBalances(
  events: readonly InventoryLedgerV2Event[],
  input: {
    orderId: string;
    variantId: string;
    pool: InventoryLedgerPool;
  },
): ReservationGenerationBalance[] {
  const balances = new Map<number, { reserved: number; consumed: number }>();

  for (const event of events) {
    validateInventoryLedgerV2Event(event);
    if (
      event.orderId !== input.orderId ||
      event.variantId !== input.variantId ||
      event.pool !== input.pool ||
      event.reservationGeneration == null
    ) {
      continue;
    }

    const generation = event.reservationGeneration;
    const balance = balances.get(generation) ?? { reserved: 0, consumed: 0 };
    if (event.reservedStockDelta > 0) {
      balance.reserved += event.reservedStockDelta;
    } else if (event.reservedStockDelta < 0) {
      balance.consumed += -event.reservedStockDelta;
    }
    balances.set(generation, balance);
  }

  return [...balances.entries()]
    .sort(([left], [right]) => left - right)
    .map(([generation, balance]) => ({
      generation,
      reserved: balance.reserved,
      consumed: balance.consumed,
      outstanding: Math.max(0, balance.reserved - balance.consumed),
    }));
}

export function getActiveReservationGeneration(
  balances: readonly ReservationGenerationBalance[],
): number | null {
  for (let index = balances.length - 1; index >= 0; index -= 1) {
    if (balances[index]!.outstanding > 0) return balances[index]!.generation;
  }
  return null;
}

export function getNextReservationGeneration(
  balances: readonly ReservationGenerationBalance[],
): number {
  const active = getActiveReservationGeneration(balances);
  if (active != null) return active;
  return (balances.at(-1)?.generation ?? 0) + 1;
}
