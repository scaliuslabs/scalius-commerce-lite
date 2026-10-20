// @vitest-environment happy-dom

// The order page across every state combination that can co-occur: the title's
// badges never contradict each other or stack up, and a card that may not apply
// is decided from the order's own facts (so it never pops in and moves the page).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FULFILLMENT_STATUSES as FULFILMENT, ORDER_STATUSES, PAYMENT_STATUSES as PAYMENT } from "@scalius/shared/order-state";
import { setLocale, translate } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderNotificationMessages } from "~/i18n/order-notifications";
import { orderReturnMessages } from "~/i18n/order-returns";
import { orderTimelineMessages } from "~/i18n/order-timeline";
import { fulfillmentStatusLabel, orderMessages, orderStatusLabel, paymentStatusLabel } from "~/i18n/orders";
import { hasDeliveryCard, hasHoldCard, hasReturnsCard } from "./card-rules";
import { fulfilledGroups, returnedByGroup } from "./fulfilment-groups";
import { OrderHeaderBadges } from "./OrderHeaderBadges";
import type { Order, OrderFulfillment } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOSED = new Set(["cancelled", "returned", "refunded", "incomplete"]);

const shipped: OrderFulfillment = {
  id: "ful_1", kind: "ship", createdAt: null, lines: [], tracking: null, status: "active",
  actorType: "admin", cashCollected: null, voidedAt: null,
};

type Case = Pick<Order, "status" | "paymentStatus" | "fulfillmentStatus" | "archivedAt" | "conversation">;
function* headerCases(): Generator<Case> {
  for (const status of ORDER_STATUSES) {
    for (const paymentStatus of PAYMENT) {
      for (const fulfillmentStatus of FULFILMENT) {
        for (const archivedAt of [null, "2026-09-30T10:00:00.000Z"]) {
          for (const unread of [false, true]) {
            yield { status, paymentStatus, fulfillmentStatus, archivedAt, conversation: unread ? { id: "conv_1", unread } : null };
          }
        }
      }
    }
  }
}

describe("order page title badges", () => {
  afterEach(() => setLocale("en"));

  it.each(["en", "bn"] as const)("never contradict or stack, in every state (%s)", async (locale) => {
    setLocale(locale);
    const o: Parameters<typeof orderStatusLabel>[0] = (key, vars) => translate(orderMessages, key, vars);
    const host = document.createElement("div");
    const root = createRoot(host);
    let checked = 0;
    for (const order of headerCases()) {
      await act(async () => root.render(<OrderHeaderBadges order={order} />));
      const strip = host.querySelector('[data-testid="order-header-badges"]')!;
      // Every badge is a leaf <span> of the strip (the unread one inside its link).
      const badges = [...strip.querySelectorAll("span")].map((element) => element.textContent ?? "");
      const closed = CLOSED.has(order.status);
      const expected = [
        ...(closed ? [orderStatusLabel(o, order.status)] : []),
        ...(closed ? [] : [paymentStatusLabel(o, order.paymentStatus!), fulfillmentStatusLabel(o, order.fulfillmentStatus!)]),
        ...(order.archivedAt ? [o("archived")] : []),
        ...(order.conversation?.unread ? [translate(orderDetailMessages, "messages.unread")] : []),
      ];
      // One strip, in Shopify's order, never more than four badges.
      expect(badges, JSON.stringify(order)).toEqual(expected);
      expect(badges.length).toBeLessThanOrEqual(4);
      checked += 1;
    }
    expect(checked).toBe(ORDER_STATUSES.length * PAYMENT.length * FULFILMENT.length * 4);
    act(() => root.unmount());
  });
});

describe("order page cards that may not apply", () => {
  const base = { status: "confirmed", refundDue: 0, fulfillments: [], shipments: [], shipmentRecovery: null } as unknown as Order;

  it("shows Delivery only once something was sent, a parcel exists, or a booking needs checking", () => {
    for (const status of ORDER_STATUSES) {
      const order = { ...base, status };
      expect(hasDeliveryCard(order)).toBe(false);
      expect(hasDeliveryCard({ ...order, fulfillments: [shipped] })).toBe(true);
      // A parcel that came back still has its story on the card.
      expect(hasDeliveryCard({ ...order, fulfillments: [{ ...shipped, status: "voided" }] })).toBe(true);
      expect(hasDeliveryCard({ ...order, fulfillments: [{ ...shipped, kind: "pickup" }] })).toBe(false);
      expect(hasDeliveryCard({ ...order, shipments: [{ id: "shp_1" } as never] })).toBe(true);
      expect(hasDeliveryCard({ ...order, shipmentRecovery: { state: "needs_attention" } as never })).toBe(true);
    }
  });

  it("shows Hold for review only while an app's hold is open", () => {
    const hold = (releasedAt: number | null) => ({
      id: "ohd_1", appId: "acme.radar", appName: "Risk radar", reason: "Returned before", placedAt: 1_790_000_000, releasedAt,
    });
    expect(hasHoldCard({ holds: [] })).toBe(false);
    expect(hasHoldCard({ holds: undefined } as never)).toBe(false);
    expect(hasHoldCard({ holds: [hold(1_790_000_600)] })).toBe(false);
    expect(hasHoldCard({ holds: [hold(1_790_000_600), hold(null)] })).toBe(true);
  });

  it("shows Returns only once the order was delivered, money is owed back, or a return exists", () => {
    const applies = new Set(["delivered", "completed", "returned", "refunded"]);
    for (const status of ORDER_STATUSES) {
      const order = { ...base, status };
      expect(hasReturnsCard(order, 0), status).toBe(applies.has(status));
      expect(hasReturnsCard({ ...order, refundDue: 120 }, 0)).toBe(true);
      expect(hasReturnsCard(order, 1)).toBe(true);
    }
  });

  it("shows each returned unit on exactly one hand-over card, oldest first, for every split and return count", () => {
    const splits = [[1], [2], [1, 1], [2, 1], [1, 1, 1], [3, 2]];
    for (const split of splits) {
      const sent = split.reduce((sum, units) => sum + units, 0);
      const order = {
        items: [{ id: "k1", quantity: sent, fulfilledQuantity: sent, fulfillmentType: "ship" }],
        fulfillments: split.map((units, index) => ({
          ...shipped,
          id: `ful_${index}`,
          createdAt: `2026-09-2${index}T08:00:00.000Z`,
          lines: [{ orderItemId: "k1", quantity: units }],
        })),
      } as unknown as Order;
      const groups = fulfilledGroups(order);
      for (let returned = 0; returned <= sent + 1; returned += 1) {
        const shown = returnedByGroup(groups, new Map([["k1", returned]])).map((map) => map.get("k1") ?? 0);
        const label = `${split.join("+")} sent, ${returned} returned`;
        // Never double-counted: the cards add up to what came back, each within what it held.
        expect(shown.reduce((sum, units) => sum + units, 0), label).toBe(Math.min(returned, sent));
        shown.forEach((units, index) => expect(units, label).toBeLessThanOrEqual(split[index]!));
        // Oldest first: a later card shows returns only once every earlier card is full.
        shown.forEach((units, index) => {
          if (index > 0 && units > 0) expect(shown[index - 1], label).toBe(split[index - 1]);
        });
      }
    }
  });

  it("gives every card on the page its own title, in both languages", () => {
    for (const locale of ["en", "bn"] as const) {
      setLocale(locale);
      const titles = [
        translate(orderDetailMessages, "status.title"),
        translate(orderDetailMessages, "shipments.title"),
        translate(orderDetailMessages, "payment.title"),
        translate(orderReturnMessages, "returns.title"),
        translate(inboxMessages, "card.title"),
        translate(orderNotificationMessages, "messages.title"),
        translate(orderTimelineMessages, "timeline.title"),
        translate(orderDetailMessages, "customer.title"),
        translate(orderDetailMessages, "notes.title"),
        translate(orderDetailMessages, "holds.title"),
      ];
      expect(new Set(titles).size, titles.join(" | ")).toBe(titles.length);
    }
    setLocale("en");
  });
});
