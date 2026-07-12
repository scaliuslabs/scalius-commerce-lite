import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invoiceIssueCommands,
  invoiceSequences,
  orderInvoices,
  orders,
} from "@scalius/database/schema";
import {
  buildInvoiceIssueRequestHash,
  getInvoiceDocument,
  issueInvoice,
} from "./invoice.service";
import { readInvoiceOrderSource } from "./invoice-order-reader";
import { getBusinessSettings } from "../settings/business-settings.service";

vi.mock("./invoice-order-reader", () => ({ readInvoiceOrderSource: vi.fn() }));
vi.mock("../settings/business-settings.service", () => ({
  getBusinessSettings: vi.fn(),
}));

const order = {
  id: "order_1",
  version: 7,
  deletedAt: null,
  customerName: "Buyer",
  customerPhone: "+8801700000000",
  customerEmail: "buyer@example.com",
  customerId: "customer_1",
  shippingAddress: "12 Test Road",
  city: "city_1",
  zone: "zone_1",
  area: null,
  cityName: "Dhaka",
  zoneName: "Dhanmondi",
  areaName: null,
  totalAmount: 110,
  shippingCharge: 10,
  discountAmount: 0,
  currencyCode: "BDT",
  currencyDecimalPlaces: 2,
  subtotalAmountMinor: 10000,
  shippingAmountMinor: 1000,
  discountAmountMinor: 0,
  taxAmountMinor: 0,
  totalAmountMinor: 11000,
  taxLabel: null,
  pricesIncludeTax: false,
  status: "delivered",
  paymentStatus: "paid",
  paymentMethod: "cod",
  fulfillmentStatus: "complete",
  paidAmount: 110,
  balanceDue: 0,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  items: [{
    id: "item_1",
    productId: "product_1",
    variantId: "variant_1",
    quantity: 1,
    price: 100,
    productName: "T-shirt",
    variantLabel: "Black / M",
    fulfillmentStatus: "delivered",
    unitPriceMinor: 10000,
    lineSubtotalMinor: 10000,
    discountAmountMinor: 0,
    taxableAmountMinor: 10000,
    taxAmountMinor: 0,
  }],
};

const businessInfo = {
  companyName: "Scalius Demo",
  legalName: "Scalius Commerce Ltd",
  addressLine1: "1 Merchant Road",
  addressLine2: "",
  city: "Dhaka",
  stateRegion: "Dhaka",
  postalCode: "1205",
  country: "Bangladesh",
  phone: "+8801800000000",
  email: "merchant@example.com",
  taxId: "",
  invoicePrefix: "SALE",
  invoiceFooterText: "Thank you",
  invoiceLogoUrl: "https://example.com/logo.png",
};

type StoredInvoice = { id: string; snapshot: string; contentHash: string };
type StoredCommand = { requestHash: string; invoiceId: string };
type Statement = { kind: "insert" | "update"; table: unknown };

function createInvoiceDb(options: {
  issued?: StoredInvoice | null;
  command?: StoredCommand | null;
  sequenceValues?: number[];
  batchResults?: unknown[][][];
  batchError?: Error;
} = {}) {
  let issued = options.issued ?? null;
  let command = options.command ?? null;
  const sequenceValues = [...(options.sequenceValues ?? [41])];
  const batchResults = [...(options.batchResults ?? [[
    [{ id: "invoice_1" }],
    [{ id: "command_1" }],
    [{ id: "order_1" }],
    [{ key: "default" }],
  ]])];
  const batches: Statement[][] = [];

  const getRow = (table: unknown) => {
    if (table === invoiceIssueCommands) return command;
    if (table === orderInvoices) return issued;
    if (table === invoiceSequences) {
      const currentValue = sequenceValues.shift();
      return currentValue == null ? null : { currentValue };
    }
    return null;
  };
  const selectBuilder = (table: unknown) => ({
    where() {
      return { get: async () => getRow(table) };
    },
    innerJoin() {
      return { where: () => ({ kind: "select", table }) };
    },
  });
  const db = {
    select() {
      return { from: (table: unknown) => selectBuilder(table) };
    },
    insert(table: unknown) {
      return {
        select() {
          return {
            returning() {
              return { kind: "insert" as const, table };
            },
          };
        },
        async values(values: { requestHash: string; invoiceId: string }) {
          if (table === invoiceIssueCommands) {
            command = { requestHash: values.requestHash, invoiceId: values.invoiceId };
          }
        },
      };
    },
    update(table: unknown) {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return { kind: "update" as const, table };
                },
              };
            },
          };
        },
      };
    },
    async batch(statements: Statement[]) {
      batches.push(statements);
      if (options.batchError) throw options.batchError;
      return batchResults.shift() ?? [];
    },
  };
  return {
    db,
    batches,
    setIssued(value: StoredInvoice | null) { issued = value; },
  };
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(",")}}`;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function storedInvoice(prefix = "SALE"): Promise<StoredInvoice> {
  const { deletedAt: _deletedAt, ...snapshotOrder } = order;
  const snapshot = stableStringify({
    schemaVersion: 1,
    renderVersion: "invoice-v1",
    invoiceNumber: 42,
    formattedNumber: `${prefix}-00042`,
    prefix,
    issuedAt: 1_700_000_200,
    businessInfo: { ...businessInfo, invoicePrefix: prefix },
    order: snapshotOrder,
  });
  return { id: "invoice_1", snapshot, contentHash: await hash(snapshot) };
}

describe("invoice authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readInvoiceOrderSource).mockResolvedValue(order as never);
    vi.mocked(getBusinessSettings).mockResolvedValue(businessInfo);
  });

  it("keeps draft GET read-only and unnumbered", async () => {
    const { db, batches } = createInvoiceDb();
    const document = await getInvoiceDocument(db as never, order.id);

    expect(document).toMatchObject({
      status: "draft",
      invoiceNumber: null,
      invoiceNum: null,
      orderVersion: 7,
    });
    expect(batches).toHaveLength(0);
  });

  it("commits snapshot, command, order CAS, and sequence CAS in one batch", async () => {
    const { db, batches } = createInvoiceDb();
    const document = await issueInvoice(
      db as never,
      order.id,
      { operationKey: "invoice-operation-0001", expectedOrderVersion: 7 },
      "admin_1",
    );

    expect(document).toMatchObject({
      status: "issued",
      invoiceNumber: "SALE-00042",
      invoiceNum: 42,
      businessInfo: { companyName: "Scalius Demo", invoicePrefix: "SALE" },
      order: { id: "order_1", version: 7 },
    });
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      expect.objectContaining({ kind: "insert", table: orderInvoices }),
      expect.objectContaining({ kind: "insert", table: invoiceIssueCommands }),
      expect.objectContaining({ kind: "update", table: orders }),
      expect.objectContaining({ kind: "update", table: invoiceSequences }),
    ]);
  });

  it("retries a lost sequence race without consuming the skipped number", async () => {
    const { db, batches } = createInvoiceDb({
      sequenceValues: [41, 42],
      batchResults: [
        [[], [], [], []],
        [[{ id: "invoice_2" }], [{ id: "command_2" }], [{ id: "order_1" }], [{ key: "default" }]],
      ],
    });
    const document = await issueInvoice(
      db as never,
      order.id,
      { operationKey: "invoice-operation-0002", expectedOrderVersion: 7 },
      "admin_1",
    );

    expect(document.invoiceNum).toBe(43);
    expect(document.invoiceNumber).toBe("SALE-00043");
    expect(batches).toHaveLength(2);
  });

  it("returns the immutable original snapshot on exact operation replay", async () => {
    const issued = await storedInvoice();
    const requestHash = await buildInvoiceIssueRequestHash(order.id, 7);
    const { db, batches } = createInvoiceDb({
      issued,
      command: { requestHash, invoiceId: issued.id },
    });
    vi.mocked(getBusinessSettings).mockResolvedValue({
      ...businessInfo,
      companyName: "Renamed Merchant",
      invoicePrefix: "NEW",
    });

    const document = await issueInvoice(
      db as never,
      order.id,
      { operationKey: "invoice-operation-replay", expectedOrderVersion: 7 },
      "admin_2",
    );

    expect(document.invoiceNumber).toBe("SALE-00042");
    expect(document.businessInfo.companyName).toBe("Scalius Demo");
    expect(batches).toHaveLength(0);
  });

  it("fails closed when stored invoice content no longer matches its hash", async () => {
    const issued = await storedInvoice();
    const { db } = createInvoiceDb({
      issued: { ...issued, snapshot: `${issued.snapshot} ` },
    });

    await expect(getInvoiceDocument(db as never, order.id))
      .rejects.toThrow("integrity check");
  });

  it("rejects one operation key reused with changed request identity", async () => {
    const issued = await storedInvoice();
    const { db } = createInvoiceDb({
      issued,
      command: { requestHash: "0".repeat(64), invoiceId: issued.id },
    });

    await expect(issueInvoice(
      db as never,
      "order_2",
      { operationKey: "invoice-operation-replay", expectedOrderVersion: 3 },
      "admin_1",
    )).rejects.toThrow("already used for a different request");
  });

  it("fails issuance until a merchant identity exists", async () => {
    vi.mocked(getBusinessSettings).mockResolvedValue({
      ...businessInfo,
      companyName: "",
      legalName: "",
    });
    const { db, batches } = createInvoiceDb();

    await expect(issueInvoice(
      db as never,
      order.id,
      { operationKey: "invoice-operation-identity", expectedOrderVersion: 7 },
      "admin_1",
    )).rejects.toThrow("company or legal name");
    expect(batches).toHaveLength(0);
  });
});
