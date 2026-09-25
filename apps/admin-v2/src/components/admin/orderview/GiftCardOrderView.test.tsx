// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import { setLocale } from "~/i18n";
import { giftCardOrderMessages } from "~/i18n/gift-card-orders";
import type { Order, OrderItem } from "./types";
import { GiftCardLinesCard, issuedGiftCards } from "./GiftCardLinesCard";
import { GiftCardTenderRows, giftCardTenderLines } from "./GiftCardTenderRows";
import { RefundSettlementField, refundSettlementBody, type RefundSettlement } from "./RefundSettlementField";

const mocks = vi.hoisted(() => ({
  canManage: true,
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("~/contexts/PermissionContext", () => ({ useHasPermission: () => mocks.canManage }));
vi.mock("~/lib/api", () => ({
  apiClient: { post: mocks.post },
  apiData: async (call: Promise<{ data?: { data?: unknown } }>) => (await call).data?.data,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = giftCardOrderMessages.en;

type PaymentRow = OrderPaymentsPayload["payments"][number];

function payment(fields: Partial<PaymentRow> & { giftCard?: unknown }): PaymentRow {
  return {
    id: "pay", orderId: "order_1", amount: 0, currency: "BDT", paymentMethod: "gift_card", paymentType: "full",
    status: "succeeded", providerRef: null, providerSecondaryRef: null, codCollectedBy: null, codCollectedAt: null,
    codReceiptUrl: null, createdAt: 1_783_000_000, updatedAt: 1_783_000_000,
    ...fields,
  } as PaymentRow;
}

const tenderCard = { id: "gc_a", last4: "7K2Q", storeCredit: false };
const creditCard = { id: "gc_b", last4: "AB12", storeCredit: true };

const baseOrder: Order = {
  id: "order_1", version: 1, customerName: "Rahim", customerPhone: "+8801700000000",
  customerEmail: "rahim@example.com", shippingAddress: "Test address", city: "Dhaka", zone: "Central Road",
  area: null, notes: null, discountAmount: 0, shippingCharge: 0, status: "delivered",
  createdAt: 1_783_000_000, updatedAt: 1_783_000_000, items: [], totalAmount: 1800,
  customerId: null, paymentMethod: "cod", paymentStatus: "paid", paidAmount: 1800,
  balanceDue: 0, orderNumber: 1001, archivedAt: null, discounts: [], refundDue: 0, refundedAmount: 0,
  editReadiness: { items: { allowed: false, reason: "closed" }, details: { allowed: false, reason: "closed" } },
};

function giftCardItem(extras: unknown): OrderItem {
  return {
    id: "item_1", productId: "product_gc", variantId: "variant_gc", quantity: 1, price: 500,
    productName: "Eid gift card", productImage: null, variantLabel: "৳500",
    fulfillmentType: "gift_card", fulfilledQuantity: 1, extras: { giftCards: extras },
  } as OrderItem;
}

describe("gift-card tender lines", () => {
  it("shows held, partly refunded and released tenders, then store credit, in integer minor units", () => {
    const lines = giftCardTenderLines([
      payment({ id: "tender_a", amount: 0.3, giftCard: tenderCard }),
      payment({ id: "refund_a1", paymentType: "refund", status: "refunded", amount: 0.1, giftCard: tenderCard }),
      payment({ id: "refund_a2", paymentType: "refund", status: "refunded", amount: 0.2, giftCard: tenderCard }),
      payment({ id: "tender_c", amount: 5, status: "refunded", giftCard: { id: "gc_c", last4: "ZZ99", storeCredit: false } }),
      payment({ id: "cod_refund", paymentMethod: "cod", paymentType: "refund", status: "refunded", amount: 11.8, giftCard: creditCard }),
      payment({ id: "gc_refund", paymentType: "refund", status: "refunded", amount: 0.2, giftCard: creditCard }),
      payment({ id: "cod", paymentMethod: "cod", amount: 11.8, giftCard: null }),
      // A failed refund row never counts.
      payment({ id: "refund_failed", paymentType: "refund", status: "failed", amount: 9, giftCard: creditCard }),
    ]);

    expect(lines).toEqual([
      expect.objectContaining({ kind: "tender", last4: "7K2Q", amountMinor: 30, refundedMinor: 30, state: "refunded" }),
      expect.objectContaining({ kind: "tender", last4: "ZZ99", amountMinor: 500, state: "released" }),
      expect.objectContaining({ kind: "storeCredit", last4: "AB12", amountMinor: 1200, state: "held" }),
    ]);
  });

  it("renders summary rows by last 4 and nothing for an order without gift cards", async () => {
    setLocale("en");
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(
      <dl>
        <GiftCardTenderRows
          order={baseOrder}
          payments={[
            payment({ id: "tender_a", amount: 500, giftCard: tenderCard }),
            payment({ id: "refund_a", paymentType: "refund", status: "refunded", amount: 100, giftCard: tenderCard }),
            payment({ id: "credit", paymentMethod: "cod", paymentType: "refund", status: "refunded", amount: 1200, giftCard: creditCard }),
          ]}
        />
      </dl>,
    ));
    const rows = [...host.querySelectorAll("dt")].map((dt) => `${dt.textContent} = ${dt.nextElementSibling?.textContent}`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Gift card •••• 7K2Q");
    expect(rows[0]).toContain("refunded");
    expect(rows[1]).toContain("Store credit •••• AB12");

    await act(async () => root.render(<dl><GiftCardTenderRows order={baseOrder} payments={[payment({ paymentMethod: "cod", giftCard: null })]} /></dl>));
    expect(host.querySelector("dt")).toBeNull();
    act(() => root.unmount());
  });
});

describe("RefundSettlementField", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLocale("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("offers original payment or store credit and says where the card goes", async () => {
    let value: RefundSettlement = "original";
    const onChange = vi.fn((next: RefundSettlement) => { value = next; });
    const render = () => root.render(<RefundSettlementField order={baseOrder} value={value} onChange={onChange} />);
    await act(async () => render());

    expect(host.textContent).toContain(en["refundTo.label"]);
    expect(host.textContent).toContain(en["refundTo.original"]);
    expect(host.textContent).not.toContain("rahim@example.com");

    const storeCredit = host.querySelector<HTMLButtonElement>("#refundSettlement-store_credit")!;
    await act(async () => storeCredit.click());
    expect(onChange).toHaveBeenCalledWith("store_credit");
    await act(async () => render());
    expect(host.querySelector("#refundSettlement-help code")?.textContent).toBe("rahim@example.com");
  });

  it("sends settlement only for store credit (original is the API default)", () => {
    expect(refundSettlementBody("original")).toEqual({});
    expect(refundSettlementBody("store_credit")).toEqual({ settlement: "store_credit" });
  });
});

describe("GiftCardLinesCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
    mocks.canManage = true;
    mocks.post.mockResolvedValue({ data: { success: true, data: { queued: true } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const renderCard = (order: Order) => act(async () => root.render(
    <QueryClientProvider client={client}><GiftCardLinesCard order={order} /></QueryClientProvider>,
  ));
  const cardExtra = {
    giftCardId: "gc_issued_1", last4: "7K2Q", initialAmount: 500, initialAmountMinor: 50000,
    currencyCode: "BDT", sentTo: "r•••@gmail.com",
  };

  it("renders nothing when the order issued no gift cards", async () => {
    await renderCard({ ...baseOrder, items: [giftCardItem(undefined)] });
    expect(host.innerHTML).toBe("");
    expect(issuedGiftCards({ items: [giftCardItem([{ giftCardId: 1 }])] })).toEqual([]);
  });

  it("lists issued cards by last 4 and resends one by id", async () => {
    await renderCard({ ...baseOrder, items: [giftCardItem([cardExtra, { ...cardExtra, giftCardId: "gc_issued_2", last4: "9QX0", sentTo: null }])] });

    expect(host.textContent).toContain("•••• 7K2Q");
    expect(host.textContent).toContain("Sent to r•••@gmail.com");
    expect(host.textContent).toContain(en["lines.sentToBuyer"]);
    expect(host.textContent).toContain("Eid gift card");
    const resend = host.querySelector<HTMLButtonElement>(`button[aria-label="Resend gift card •••• 7K2Q"]`)!;
    await act(async () => resend.click());
    expect(mocks.post).toHaveBeenCalledWith({ url: "/api/v1/admin/gift-cards/gc_issued_1/resend" });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(en["lines.resent"]);
  });

  it("hides Resend from staff who can't manage gift cards", async () => {
    mocks.canManage = false;
    await renderCard({ ...baseOrder, items: [giftCardItem([cardExtra])] });
    expect(host.textContent).toContain("•••• 7K2Q");
    expect(host.querySelector("button")).toBeNull();
  });
});
