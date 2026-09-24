import { orderDetailLabel, type OrderDetailMessageKey } from "~/i18n/order-detail";
import { orderStatusLabel, type OrderMessageKey } from "~/i18n/orders";
import type { OrderTimelineEvent } from "./api-query-options/orders";

type Vars = Record<string, string | number>;
type DetailT = (key: OrderDetailMessageKey, vars?: Vars) => string;
type OrderT = (key: OrderMessageKey, vars?: Vars) => string;

export interface TimelineLine {
  /** What happened, in one sentence. */
  text: string;
  /** Staff comment, failed-delivery note or reason, shown under the sentence. */
  detail: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Words every timeline kind; `money` formats a major-unit amount in the order's currency. */
export function describeTimelineEvent(
  event: Pick<OrderTimelineEvent, "kind" | "body" | "data">,
  t: DetailT,
  o: OrderT,
  money: (amount: number) => string,
): TimelineLine {
  const data = event.data ?? {};
  const body = text(event.body);
  switch (event.kind) {
    case "placed":
      return { text: t("timeline.placed"), detail: null };
    case "comment":
      return { text: body ?? "", detail: null };
    case "status_changed": {
      const to = text(data.to) ?? "";
      const reason = text(data.reason);
      return {
        text: to === "cancelled"
          ? t("timeline.cancelled")
          : t("timeline.statusChanged", { status: orderStatusLabel(o, to) }),
        detail: reason ? orderDetailLabel(t, "cancel.reason.", reason) : null,
      };
    }
    case "details_edited":
      return { text: t("timeline.detailsEdited"), detail: null };
    case "items_edited":
      return {
        text: t("timeline.itemsEdited", { from: money(count(data.previousTotal)), to: money(count(data.total)) }),
        detail: null,
      };
    case "shipment_created": {
      const courier = text(data.courierName);
      const tracking = text(data.trackingId);
      return {
        text: courier ? t("timeline.sentWith", { courier }) : t("timeline.sent"),
        detail: tracking ? t("timeline.tracking", { id: tracking }) : null,
      };
    }
    case "cod_collected":
      return {
        text: t("timeline.codCollected", { amount: money(count(data.amount)) }),
        detail: text(data.collectedBy) ? t("cod.collectedByName", { name: text(data.collectedBy)! }) : null,
      };
    case "cod_failed":
      return {
        text: t("timeline.codFailed", { reason: orderDetailLabel(t, "cod.reason.", text(data.reason) ?? "other") }),
        detail: body,
      };
    case "cod_returned":
      return { text: t("timeline.codReturned"), detail: null };
    case "refund_recorded":
      return {
        text: t("timeline.refunded", { amount: money(count(data.amount)) }),
        detail: body ? orderDetailLabel(t, "refund.reason.", body) : null,
      };
    case "return_created":
      return { text: t("timeline.returnCreated", { count: count(data.quantity) }), detail: body };
    case "return_received":
      return {
        text: t("timeline.returnReceived", { count: count(data.received) }),
        detail: count(data.restocked) > 0 ? t("returns.qtyRestocked", { count: count(data.restocked) }) : null,
      };
    case "request_resolved": {
      const type = text(data.type);
      const request = type === "cancel_pre_shipment" || type === "return" || type === "refund"
        ? o(`request.${type}`)
        : t("timeline.request");
      return {
        text: t("timeline.requestResolved", {
          request,
          status: orderDetailLabel(t, "requests.status.", text(data.status) ?? ""),
        }),
        detail: body,
      };
    }
    case "archived":
      return { text: t("timeline.archived"), detail: null };
    case "unarchived":
      return { text: t("timeline.unarchived"), detail: null };
    case "invoice_issued":
      return { text: t("timeline.invoiceIssued", { number: text(data.number) ?? "" }), detail: null };
    default:
      return { text: body ?? "", detail: null };
  }
}
