// A courier's report about a shipment, applied by the shipment machine
// (@scalius/shared/shipment-state) and never dropped. A courier push and a
// staff refresh both come here:
//
// - a move the machine declares (an open shipment, a correction of a settled
//   one, a re-report of the state it is in) is written;
// - a report naming another state over a settled shipment, which no move
//   allows, holds the shipment for staff (`reconcile_required`) with the
//   courier's report as `reconciliation.providerStatus`, so Repair restores it
//   to that report, and writes an order timeline line saying what the courier
//   reported, in one batch;
// - a shipment already held for staff takes no report (the caller asks the
//   courier to send it again, or says it waits).
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { deliveryShipments, orderEvents, ShipmentStatus } from "@scalius/database/schema";
import type { CourierShipmentStatus } from "@scalius/shared/plugins/providers";
import { courierReportHolds } from "@scalius/shared/shipment-state";
import { NotFoundError } from "@scalius/core/errors";
import { orderEventData } from "../../utils/agent-attribution";
import { shipmentMove } from "./shipment-move";
import { COURIER_REPORT_HELD } from "./types";

type ShipmentColumns = typeof deliveryShipments.$inferInsert;

export interface CourierReport {
  status: CourierShipmentStatus;
  /** The courier's own words for it. */
  rawStatus: string;
  /** The courier's facts, merged into the shipment's metadata whatever happens. */
  details?: Record<string, unknown>;
  /** Columns a write sets beside the status (`lastChecked`, `updatedAt`). */
  set?: { [K in "lastChecked" | "updatedAt"]?: ShipmentColumns[K] };
}

/** What became of a report. Each caller acts on every outcome. */
export type CourierReportOutcome =
  /** Written: a move, or a re-report of the state the shipment is in. */
  | { outcome: "applied"; status: CourierShipmentStatus }
  /** The settled shipment takes no move to the report: it is held for staff with it now. */
  | { outcome: "held"; previous: string; reported: CourierShipmentStatus }
  /** The shipment was already held for staff: nothing written. */
  | { outcome: "waiting" };

const HOLD_ATTEMPTS = 3;

function parseMetadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Applies a courier's report to a shipment (see the file's head). */
export async function applyCourierReport(db: Database, shipmentId: string, report: CourierReport): Promise<CourierReportOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const row = await db.select({ status: deliveryShipments.status, orderId: deliveryShipments.orderId, metadata: deliveryShipments.metadata, courierName: deliveryShipments.courierName })
      .from(deliveryShipments).where(eq(deliveryShipments.id, shipmentId)).get();
    if (!row) throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
    if (row.status === ShipmentStatus.RECONCILE_REQUIRED) return { outcome: "waiting" };
    const metadata = { ...parseMetadata(row.metadata), ...(report.details ?? {}) };

    if (!courierReportHolds(row.status, report.status)) {
      // The machine judges it in the write, from the state read: a report that lost a race reads again.
      const written = await shipmentMove(db, report.status, "courier", and(eq(deliveryShipments.id, shipmentId), eq(deliveryShipments.status, row.status)), {
        ...report.set,
        rawStatus: report.rawStatus,
        metadata: JSON.stringify(metadata),
      }).returning({ id: deliveryShipments.id });
      if (written.length > 0) return { outcome: "applied", status: report.status };
    } else {
      const reconciliation = {
        required: true,
        reason: COURIER_REPORT_HELD,
        providerStatus: report.status,
        rawProviderStatus: report.rawStatus,
        previousStatus: row.status,
        detectedAt: new Date().toISOString(),
      };
      const held = sql`EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.id} = ${shipmentId}
        AND ${deliveryShipments.status} = ${ShipmentStatus.RECONCILE_REQUIRED} AND ${deliveryShipments.rawStatus} = ${COURIER_REPORT_HELD})`;
      const [written] = await safeBatch(db, [
        shipmentMove(db, ShipmentStatus.RECONCILE_REQUIRED, "store", and(eq(deliveryShipments.id, shipmentId), eq(deliveryShipments.status, row.status)), {
          ...report.set,
          rawStatus: COURIER_REPORT_HELD,
          metadata: JSON.stringify({ ...metadata, reconciliation }),
        }).returning({ id: deliveryShipments.id }),
        // What the courier reported, on the order's timeline (the dashboard words it).
        db.insert(orderEvents).select(sql`
          SELECT ${`oev_${Date.now().toString(36).padStart(9, "0")}${nanoid(8)}`}, ${row.orderId}, 'courier_report', NULL,
                 ${orderEventData({ shipmentId, courierName: row.courierName, previousStatus: row.status, reportedStatus: report.status, rawStatus: report.rawStatus })},
                 NULL, NULL, unixepoch()
          WHERE ${held}
        `),
      ] as never) as unknown as [Array<{ id: string }>, unknown];
      if (written.length > 0) return { outcome: "held", previous: row.status, reported: report.status };
    }
    if (attempt >= HOLD_ATTEMPTS) throw new Error(`Shipment ${shipmentId} kept changing while a courier report was applied.`);
  }
}
