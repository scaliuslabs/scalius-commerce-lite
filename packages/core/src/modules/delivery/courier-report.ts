// A courier's report about a shipment, applied by the shipment machine
// (@scalius/shared/shipment-state `courierReportOutcome`) and never dropped.
// A courier push and a staff refresh both come here:
//
// - a move the machine declares (an open shipment, a correction of a settled
//   one, a re-report of the state it is in) is written;
// - a late or vague report over a settled shipment (an open state, `unknown`,
//   `delivered` over a partial delivery) is recorded: its words are kept on
//   the shipment, one timeline line per distinct report says so, and nothing
//   moves, holds or locks;
// - a report naming another settled state, which no correction allows (and a
//   `returned` over a delivered parcel whose cash was collected), holds the
//   shipment for staff (`reconcile_required`) with the report as
//   `reconciliation.providerStatus` and the state it was in as
//   `reconciliation.previousStatus`, and writes a timeline line, in one
//   batch: staff apply it or keep the shipment as it was
//   (fulfilment/reconcile.ts `resolveCourierReport`);
// - a shipment held for staff takes no report: one held for a courier's
//   report keeps the courier's latest settled word, so staff never apply a
//   stale one, and the caller asks the courier to send it again.
import { and, eq, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { codTracking, CodStatus, deliveryShipments, orderEvents, ShipmentStatus } from "@scalius/database/schema";
import type { CourierShipmentStatus } from "@scalius/shared/plugins/providers";
import { courierReportOutcome, isSettledShipment } from "@scalius/shared/shipment-state";
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
  /** A late or vague report over a settled shipment: its words are kept, nothing moved. */
  | { outcome: "recorded"; status: string }
  /** The settled shipment takes no move to the report: it is held for staff with it now. */
  | { outcome: "held"; previous: string; reported: CourierShipmentStatus }
  /** The shipment was already held for staff: nothing moved (a courier's latest settled word is kept). */
  | { outcome: "waiting" };

const ATTEMPTS = 3;

function parseMetadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The id of a new timeline line. */
function lineId(): string {
  return `oev_${Date.now().toString(36).padStart(9, "0")}${nanoid(8)}`;
}

/**
 * The order's `courier_report` timeline line for one report of one shipment,
 * written only while `landed` holds and only once per distinct report (its
 * outcome, state and words).
 */
export function courierReportLine(
  db: Database,
  input: { orderId: string; shipmentId: string; courierName: string | null; outcome: "held" | "recorded" | "dismissed"; previousStatus: string; reportedStatus: string; rawStatus: string },
  landed: SQL,
) {
  const data = orderEventData({
    shipmentId: input.shipmentId,
    courierName: input.courierName,
    outcome: input.outcome,
    previousStatus: input.previousStatus,
    reportedStatus: input.reportedStatus,
    rawStatus: input.rawStatus,
  });
  const field = (path: string) => sql`CASE WHEN json_valid(${orderEvents.data}) THEN json_extract(${orderEvents.data}, ${path}) END`;
  const same = sql`EXISTS (SELECT 1 FROM ${orderEvents}
    WHERE ${orderEvents.orderId} = ${input.orderId} AND ${orderEvents.kind} = 'courier_report'
      AND ${field("$.shipmentId")} = ${input.shipmentId}
      AND ${field("$.outcome")} = ${input.outcome}
      AND ${field("$.reportedStatus")} = ${input.reportedStatus}
      AND ${field("$.rawStatus")} = ${input.rawStatus})`;
  return db.insert(orderEvents).select(sql`
    SELECT ${lineId()}, ${input.orderId}, 'courier_report', NULL, ${data}, NULL, NULL, unixepoch()
    WHERE ${landed} AND NOT ${same}
  `);
}

/** Applies a courier's report to a shipment (see the file's head). */
export async function applyCourierReport(db: Database, shipmentId: string, report: CourierReport): Promise<CourierReportOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const row = await db.select({
      status: deliveryShipments.status, rawStatus: deliveryShipments.rawStatus, orderId: deliveryShipments.orderId,
      metadata: deliveryShipments.metadata, courierName: deliveryShipments.courierName,
    }).from(deliveryShipments).where(eq(deliveryShipments.id, shipmentId)).get();
    if (!row) throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
    const metadata = { ...parseMetadata(row.metadata), ...(report.details ?? {}) };
    // The row as read: its state and its facts (a write that raced another reads again).
    const unchanged = and(eq(deliveryShipments.id, shipmentId), eq(deliveryShipments.status, row.status),
      sql`coalesce(${deliveryShipments.metadata}, '') = ${row.metadata ?? ""}`);

    if (row.status === ShipmentStatus.RECONCILE_REQUIRED) {
      const held = record(metadata.reconciliation);
      // A courier's report held for staff keeps the courier's latest settled word (never a late open one).
      if (row.rawStatus === COURIER_REPORT_HELD && isSettledShipment(report.status) && held.providerStatus !== report.status) {
        await db.update(deliveryShipments).set({
          lastChecked: report.set?.lastChecked ?? sql`${deliveryShipments.lastChecked}`,
          metadata: JSON.stringify({ ...metadata, reconciliation: { ...held, providerStatus: report.status, rawProviderStatus: report.rawStatus, updatedAt: new Date().toISOString() } }),
        }).where(unchanged);
      }
      return { outcome: "waiting" };
    }

    let outcome = courierReportOutcome(row.status, report.status);
    // Cash collected at the door, then the courier says the parcel came back:
    // the store's own return refuses a collected order, so staff decide.
    if (outcome === "move" && row.status === ShipmentStatus.DELIVERED && report.status === ShipmentStatus.RETURNED) {
      const cash = await db.select({ status: codTracking.codStatus }).from(codTracking).where(eq(codTracking.orderId, row.orderId)).get();
      if (cash?.status === CodStatus.COLLECTED) outcome = "hold";
    }

    if (outcome === "move") {
      // The machine judges it in the write, from the state read: a report that lost a race reads again.
      const written = await shipmentMove(db, report.status, "courier", and(eq(deliveryShipments.id, shipmentId), eq(deliveryShipments.status, row.status)), {
        ...report.set,
        rawStatus: report.rawStatus,
        metadata: JSON.stringify(metadata),
      }).returning({ id: deliveryShipments.id });
      if (written.length > 0) return { outcome: "applied", status: report.status };
    } else if (outcome === "record") {
      // Late or vague: the courier's words are kept beside the settled state, nothing moves.
      const lastReport = { status: report.status, rawStatus: report.rawStatus, at: new Date().toISOString() };
      const kept = sql`EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.id} = ${shipmentId}
        AND ${deliveryShipments.status} = ${row.status}
        AND json_extract(${deliveryShipments.metadata}, '$.lateReport.rawStatus') = ${report.rawStatus})`;
      const [written] = await safeBatch(db, [
        db.update(deliveryShipments).set({
          lastChecked: report.set?.lastChecked ?? sql`${deliveryShipments.lastChecked}`,
          metadata: JSON.stringify({ ...metadata, lateReport: lastReport }),
        }).where(unchanged).returning({ id: deliveryShipments.id }),
        courierReportLine(db, {
          orderId: row.orderId, shipmentId, courierName: row.courierName, outcome: "recorded",
          previousStatus: row.status, reportedStatus: report.status, rawStatus: report.rawStatus,
        }, kept),
      ] as never) as unknown as [Array<{ id: string }>, unknown];
      if (written.length > 0) return { outcome: "recorded", status: row.status };
    } else {
      const reconciliation = {
        required: true,
        reason: COURIER_REPORT_HELD,
        providerStatus: report.status,
        rawProviderStatus: report.rawStatus,
        previousStatus: row.status,
        detectedAt: new Date().toISOString(),
      };
      // The line is pinned to this very report holding this shipment: a concurrent duplicate that did not hold writes none.
      const held = sql`EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.id} = ${shipmentId}
        AND ${deliveryShipments.status} = ${ShipmentStatus.RECONCILE_REQUIRED} AND ${deliveryShipments.rawStatus} = ${COURIER_REPORT_HELD}
        AND json_extract(${deliveryShipments.metadata}, '$.reconciliation.providerStatus') = ${report.status}
        AND json_extract(${deliveryShipments.metadata}, '$.reconciliation.rawProviderStatus') = ${report.rawStatus}
        AND json_extract(${deliveryShipments.metadata}, '$.reconciliation.previousStatus') = ${row.status})`;
      const [written] = await safeBatch(db, [
        shipmentMove(db, ShipmentStatus.RECONCILE_REQUIRED, "store", unchanged, {
          ...report.set,
          rawStatus: COURIER_REPORT_HELD,
          metadata: JSON.stringify({ ...metadata, reconciliation }),
        }).returning({ id: deliveryShipments.id }),
        courierReportLine(db, {
          orderId: row.orderId, shipmentId, courierName: row.courierName, outcome: "held",
          previousStatus: row.status, reportedStatus: report.status, rawStatus: report.rawStatus,
        }, held),
      ] as never) as unknown as [Array<{ id: string }>, unknown];
      if (written.length > 0) return { outcome: "held", previous: row.status, reported: report.status };
    }
    if (attempt >= ATTEMPTS) throw new Error(`Shipment ${shipmentId} kept changing while a courier report was applied.`);
  }
}
