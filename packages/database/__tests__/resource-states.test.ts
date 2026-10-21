// The sealed representation state lists (`@scalius/shared/resource-states`,
// audit L7) and what the store keeps: a column's closed list is the sealed
// list, and a constant a column writes from holds only sealed values, so a
// webhook or app read never meets a state its schema refuses.
import { describe, expect, it } from "vitest";
import {
  FULFILLMENT_RECORD_STATUSES,
  FULFILLMENT_TYPES,
  ORDER_CHANNELS,
  ORDER_STATUSES,
  PAYMENT_RECORD_STATUSES,
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  REFUND_SETTLEMENTS,
  REFUND_STATUSES,
  RETURN_SOURCES,
  RETURN_STATUSES,
  SHIPMENT_STATUSES,
} from "@scalius/shared/resource-states";
import { orderFulfillments, orderRefunds, orderReturns, orders } from "../src/schema";
import { FulfillmentStatus, OrderStatus, PaymentRecordStatus, PaymentStatus, ShipmentStatus } from "../src/schema/enums";

const sorted = (values: readonly string[]) => [...values].sort();

describe("sealed resource states", () => {
  it("are the closed lists of the columns that hold them", () => {
    expect(sorted(orders.channel.enumValues)).toEqual(sorted(ORDER_CHANNELS));
    expect(sorted(orderReturns.status.enumValues)).toEqual(sorted(RETURN_STATUSES));
    expect(sorted(orderReturns.source.enumValues)).toEqual(sorted(RETURN_SOURCES));
    expect(sorted(orderRefunds.status.enumValues)).toEqual(sorted(REFUND_STATUSES));
    expect(sorted(orderRefunds.settlement.enumValues)).toEqual(sorted(REFUND_SETTLEMENTS));
    expect(sorted(orderFulfillments.kind.enumValues)).toEqual(sorted(FULFILLMENT_TYPES));
    expect(sorted(orderFulfillments.status.enumValues)).toEqual(sorted(FULFILLMENT_RECORD_STATUSES));
  });

  it("hold every value the stores' state constants write", () => {
    expect(sorted(Object.values(OrderStatus))).toEqual(sorted(ORDER_STATUSES));
    expect(sorted(Object.values(PaymentStatus))).toEqual(sorted(PAYMENT_STATUSES));
    expect(sorted(Object.values(FulfillmentStatus))).toEqual(sorted(FULFILLMENT_STATUSES));
    expect(sorted(Object.values(PaymentRecordStatus))).toEqual(sorted(PAYMENT_RECORD_STATUSES));
    expect(sorted(Object.values(ShipmentStatus))).toEqual(sorted(SHIPMENT_STATUSES));
  });
});
