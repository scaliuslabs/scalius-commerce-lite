// tests/setup.ts
// Shared test helpers: mock factories, seed data generators.
// Unit tests mock the DB at the drizzle level; integration tests use miniflare.

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

export interface MockDbCall {
  method: string;
  args: unknown[];
}

/**
 * Creates a mock drizzle-style database for unit tests.
 *
 * - Tracks all calls for assertion
 * - Returns configurable results for select/update/insert/delete
 * - Supports `batch()` for atomic multi-statement operations
 */
export function createMockDb(overrides: {
  selectResult?: unknown;
  insertResult?: unknown;
  updateResult?: unknown;
  deleteResult?: unknown;
  batchResults?: unknown[];
} = {}) {
  const calls: MockDbCall[] = [];

  const chainable = (method: string, returnValue: unknown) => {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const methods = ["from", "where", "set", "values", "returning", "orderBy", "limit", "offset", "groupBy", "leftJoin", "innerJoin"];
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ method: `${method}.${m}`, args });
        return chain;
      };
    }
    chain.get = () => {
      calls.push({ method: `${method}.get`, args: [] });
      return returnValue;
    };
    chain.all = () => {
      calls.push({ method: `${method}.all`, args: [] });
      return Array.isArray(returnValue) ? returnValue : returnValue ? [returnValue] : [];
    };
    // Make it thenable so `await db.select()...` works
    chain.then = (resolve: (v: unknown) => void) => {
      const val = Array.isArray(returnValue) ? returnValue : returnValue ? [returnValue] : [];
      return Promise.resolve(val).then(resolve);
    };
    return chain;
  };

  const db = {
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return chainable("select", overrides.selectResult ?? null);
    },
    insert: (...args: unknown[]) => {
      calls.push({ method: "insert", args });
      return chainable("insert", overrides.insertResult ?? [{ id: "mock-id" }]);
    },
    update: (...args: unknown[]) => {
      calls.push({ method: "update", args });
      return chainable("update", overrides.updateResult ?? [{ id: "mock-id" }]);
    },
    delete: (...args: unknown[]) => {
      calls.push({ method: "delete", args });
      return chainable("delete", overrides.deleteResult ?? undefined);
    },
    batch: async (stmts: unknown[]) => {
      calls.push({ method: "batch", args: stmts });
      return overrides.batchResults ?? stmts.map(() => []);
    },
    _calls: calls,
    _reset: () => {
      calls.length = 0;
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Mock Cloudflare environment
// ---------------------------------------------------------------------------

export function createMockEnv() {
  return {
    DB: createMockD1(),
    KV: createMockKV(),
    R2: createMockR2(),
    QUEUE: createMockQueue(),
  };
}

function createMockD1() {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: [...store.keys()].map(name => ({ name })) })),
    _store: store,
  };
}

function createMockR2() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [] }),
  };
}

function createMockQueue() {
  const messages: unknown[] = [];
  return {
    send: vi.fn(async (msg: unknown) => { messages.push(msg); }),
    sendBatch: vi.fn(async (msgs: unknown[]) => { messages.push(...msgs); }),
    _messages: messages,
  };
}

// ---------------------------------------------------------------------------
// Seed data generators
// ---------------------------------------------------------------------------

export function seedProduct(overrides: Partial<{
  id: string;
  name: string;
  price: number;
  stock: number;
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? `prod_${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? "Test Product",
    price: overrides.price ?? 1000,
    stock: overrides.stock ?? 100,
    status: overrides.status ?? "active",
  };
}

export function seedVariant(overrides: Partial<{
  id: string;
  productId: string;
  sku: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  version: number;
  size: string | null;
  color: string | null;
  weight: number | null;
}> = {}) {
  return {
    id: overrides.id ?? `var_${Math.random().toString(36).slice(2, 10)}`,
    productId: overrides.productId ?? `prod_${Math.random().toString(36).slice(2, 10)}`,
    sku: overrides.sku ?? `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    stock: overrides.stock ?? 50,
    reservedStock: overrides.reservedStock ?? 0,
    preorderStock: overrides.preorderStock ?? 0,
    allowPreorder: overrides.allowPreorder ?? false,
    allowBackorder: overrides.allowBackorder ?? false,
    backorderLimit: overrides.backorderLimit ?? 0,
    version: overrides.version ?? 1,
    size: overrides.size ?? null,
    color: overrides.color ?? null,
    weight: overrides.weight ?? null,
    deletedAt: null,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

export function seedOrder(overrides: Partial<{
  id: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentStatus: string;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  inventoryAction: string;
  inventoryPool: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
}> = {}) {
  const totalAmount = overrides.totalAmount ?? 2500;
  return {
    id: overrides.id ?? `ORD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    status: overrides.status ?? "pending",
    paymentStatus: overrides.paymentStatus ?? "unpaid",
    paymentMethod: overrides.paymentMethod ?? "cod",
    fulfillmentStatus: overrides.fulfillmentStatus ?? "pending",
    totalAmount,
    paidAmount: overrides.paidAmount ?? 0,
    balanceDue: overrides.balanceDue ?? totalAmount,
    inventoryAction: overrides.inventoryAction ?? "none",
    inventoryPool: overrides.inventoryPool ?? "regular",
    customerId: overrides.customerId ?? `cust_${Math.random().toString(36).slice(2, 10)}`,
    customerName: overrides.customerName ?? "Test Customer",
    customerPhone: overrides.customerPhone ?? "+8801700000000",
    shippingCharge: 60,
    discountAmount: 0,
    shippingAddress: "123 Test Street",
    city: "dhaka",
    zone: "zone1",
    area: null,
    notes: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    deletedAt: null,
  };
}

export function seedOrderItem(overrides: Partial<{
  id: string;
  orderId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
}> = {}) {
  return {
    id: overrides.id ?? `item_${Math.random().toString(36).slice(2, 10)}`,
    orderId: overrides.orderId ?? "ORD-TEST",
    productId: overrides.productId ?? `prod_${Math.random().toString(36).slice(2, 10)}`,
    variantId: overrides.variantId ?? `var_${Math.random().toString(36).slice(2, 10)}`,
    quantity: overrides.quantity ?? 2,
    price: overrides.price ?? 500,
    fulfillmentStatus: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };
}

export function seedCustomer(overrides: Partial<{
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totalOrders: number;
  totalSpent: number;
}> = {}) {
  return {
    id: overrides.id ?? `cust_${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? "Test Customer",
    phone: overrides.phone ?? "+8801700000000",
    email: overrides.email ?? null,
    totalOrders: overrides.totalOrders ?? 0,
    totalSpent: overrides.totalSpent ?? 0,
    lastOrderAt: null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
  };
}
