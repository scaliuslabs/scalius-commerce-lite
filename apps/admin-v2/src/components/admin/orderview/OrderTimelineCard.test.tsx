// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { describeTimelineEvent } from "~/lib/order-timeline-display";
import type { Order } from "./types";
import { OrderTimelineCard } from "./OrderTimelineCard";

const mocks = vi.hoisted(() => ({ post: vi.fn(), remove: vi.fn(), pending: false }));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ symbol: "৳", fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/hooks/use-order-action-permissions", () => ({ useOrderActionPermissions: () => ({ canEditOrders: true }) }));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderTimelineQueryOptions: (id: string) => ({ queryKey: ["timeline", id], queryFn: () => new Promise(() => undefined) }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useAddOrderComment: () => ({ mutate: mocks.post, reset: vi.fn(), isPending: mocks.pending, isError: false }),
  useDeleteOrderComment: () => ({ mutate: mocks.remove, isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;
const t = (key: keyof typeof en, vars?: Record<string, string | number>) => translate(orderDetailMessages, key, vars);
const o = (key: keyof typeof orderMessages.en, vars?: Record<string, string | number>) => translate(orderMessages, key, vars);
const money = (amount: number) => `৳${amount}`;

const order = { id: "ord_1", items: [], totalAmount: 1000, currencyCode: "BDT" } as unknown as Order;
const event = (overrides: Record<string, unknown>) => ({
  id: "evt_1", kind: "comment", body: "Customer confirmed on the phone", data: null,
  actorName: "Rahim", createdAt: 1_783_000_000, own: false, ...overrides,
});

describe("OrderTimelineCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
  });

  async function render(events: ReturnType<typeof event>[] = []) {
    client.setQueryData(["timeline", order.id], { events });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <OrderTimelineCard order={order} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  const textarea = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
  function type(value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  }
  const ctrlEnter = () => textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));

  it("posts with Ctrl+Enter and keeps one request key per draft", async () => {
    await render();
    await act(async () => type("Customer confirmed on the phone"));
    await act(async () => ctrlEnter());
    await act(async () => ctrlEnter());

    expect(mocks.post).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.post.mock.calls.map(([payload]) => payload);
    expect(first).toEqual({ orderId: "ord_1", body: "Customer confirmed on the phone", requestKey: expect.any(String) });
    // The same draft sent twice carries the same key, so the server adds it once.
    expect(second.requestKey).toBe(first.requestKey);

    // After it's posted, the next comment is a new draft with a new key.
    await act(async () => mocks.post.mock.calls[0]![1].onSuccess());
    await act(async () => type("Rider will call first"));
    await act(async () => ctrlEnter());
    expect(mocks.post.mock.calls[2]![0].requestKey).not.toBe(first.requestKey);
  });

  it("ignores a plain Enter and won't post while a comment is being sent", async () => {
    await render();
    await act(async () => type("Line one"));
    await act(async () => textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mocks.post).not.toHaveBeenCalled();

    mocks.pending = true;
    await render();
    await act(async () => ctrlEnter());
    expect(mocks.post).not.toHaveBeenCalled();
    const postButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("type") === "submit")!;
    expect(postButton.disabled).toBe(true);
  });

  it("lets the author delete their own comment after confirming", async () => {
    await render([event({ id: "evt_own", own: true }), event({ id: "evt_other", body: "Someone else's note" })]);
    const deletes = [...host.querySelectorAll("button")].filter((button) => button.textContent === en["timeline.delete"]);
    expect(deletes).toHaveLength(1);

    await act(async () => deletes[0]!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(en["timeline.deleteTitle"]);
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === en["timeline.delete"])!;
    await act(async () => confirm.click());
    expect(mocks.remove).toHaveBeenCalledWith({ orderId: "ord_1", eventId: "evt_own" }, expect.anything());
  });
});

describe("timeline wording", () => {
  it("says how many items went out and names the merchant's own rider in their language", () => {
    const line = describeTimelineEvent(
      { kind: "shipment_created", body: null, data: { quantity: 2, items: [{ itemId: "i1", quantity: 2 }], trackingId: "TRK-1" } },
      t, o, money,
    );
    expect(line.text).toBe(t("timeline.sentItems", { count: 2, courier: en["fulfill.defaultCourier"] }));
    expect(line.detail).toBe(t("timeline.tracking", { id: "TRK-1" }));
    expect(describeTimelineEvent({ kind: "shipment_created", body: null, data: { quantity: 1, courierName: "Rider Jamal" } }, t, o, money).text)
      .toBe("1 item sent with Rider Jamal");
  });

  it("records what the customer asked for, with their reason", () => {
    const line = describeTimelineEvent(
      { kind: "request_submitted", body: "Ordered by mistake", data: { type: "cancel_pre_shipment", reason: "Ordered by mistake" } } as never,
      t, o, money,
    );
    expect(line).toEqual({ text: en["timeline.requestSubmitted.cancel_pre_shipment"], detail: "Ordered by mistake" });
  });
});
