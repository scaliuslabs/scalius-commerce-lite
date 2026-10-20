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
  event: Pick<OrderTimelineEvent, "kind" | "body" | "data"> & { actorName?: string | null },
  t: DetailT,
  o: OrderT,
  money: (amount: number) => string,
): TimelineLine {
  const data = event.data ?? {};
  const body = text(event.body);
  switch (event.kind) {
    case "placed": {
      // A manual order names the staff member who created it; a storefront order has no actor.
      const actor = text(event.actorName);
      return { text: actor ? t("timeline.createdBy", { name: actor }) : t("timeline.placed"), detail: null };
    }
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
      // No courier typed means the merchant's own rider, named in the merchant's language.
      const courier = text(data.courierName) ?? t("fulfill.defaultCourier");
      const quantity = count(data.quantity);
      const tracking = text(data.trackingId);
      return {
        text: quantity > 0
          ? t(quantity === 1 ? "timeline.sentItem" : "timeline.sentItems", { count: quantity, courier })
          : t("timeline.sentWith", { courier }),
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
    case "payment_recorded":
      return {
        text: t("timeline.paymentRecorded", {
          amount: money(count(data.amount)),
          via: orderDetailLabel(t, "netTerms.via.", text(data.via) ?? "other"),
        }),
        detail: text(data.reference) ? t("timeline.paymentReference", { reference: text(data.reference)! }) : null,
      };
    case "refund_recorded":
      return {
        text: t("timeline.refunded", { amount: money(count(data.amount)) }),
        detail: body ? orderDetailLabel(t, "refund.reason.", body) : null,
      };
    case "return_created":
      return { text: t("timeline.returnCreated", { count: count(data.quantity) }), detail: body };
    case "return_approved": {
      const approved = count(data.approved);
      const rejected = count(data.rejected);
      if (approved === 0) return { text: t("timeline.returnRejected"), detail: null };
      return {
        text: approved === 1 ? t("timeline.returnApprovedOne") : t("timeline.returnApprovedMany", { count: approved }),
        detail: rejected > 0 ? t("timeline.rejectedCount", { count: rejected }) : null,
      };
    }
    case "return_received":
      return {
        text: count(data.damaged) > 0
          ? t("timeline.returnReceivedDamaged", { count: count(data.received), damaged: count(data.damaged) })
          : t("timeline.returnReceived", { count: count(data.received) }),
        detail: count(data.restocked) > 0 ? t("returns.qtyRestocked", { count: count(data.restocked) }) : null,
      };
    case "parcel_returned":
      return {
        text: count(data.quantity) === 1
          ? t("timeline.parcelReturnedOne")
          : t("timeline.parcelReturnedMany", { count: count(data.quantity) }),
        detail: null,
      };
    case "request_submitted": {
      const type = text(data.type);
      return {
        text: type === "cancel_pre_shipment" || type === "return" || type === "refund"
          ? t(`timeline.requestSubmitted.${type}`)
          : t("timeline.request"),
        detail: text(data.reason) ?? body,
      };
    }
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
    case "fulfillment_location_changed": {
      // Names as they were when it changed; the order may follow the store default.
      const to = text(data.toName);
      const from = text(data.fromName);
      return {
        text: to ? t("timeline.locationChanged", { location: to }) : t("timeline.locationChangedUnnamed"),
        detail: from && from !== to ? t("timeline.locationWas", { location: from }) : null,
      };
    }
    case "prices_set":
      // Staff or an app priced lines by hand when placing the order.
      return { text: t("timeline.pricesSet"), detail: null };
    case "app_event": {
      // An app's typed line: its name and the kind's title, then its message and facts as written.
      const fields = data.fields && typeof data.fields === "object" && !Array.isArray(data.fields)
        ? Object.entries(data.fields as Record<string, unknown>)
          .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
          .map(([key, value]) => `${key}: ${String(value)}`)
        : [];
      return {
        text: t("timeline.appEvent", { app: text(data.appName) ?? text(data.pluginId) ?? "", title: text(data.title) ?? text(data.kind) ?? "" }),
        detail: [body, fields.join(" · ")].filter((part): part is string => Boolean(part)).join(" · ") || null,
      };
    }
    default:
      return { text: body ?? "", detail: null };
  }
}
