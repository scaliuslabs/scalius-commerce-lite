// The one way a shipment's status changes (`delivery_shipments.status`): the
// update of a move of SHIPMENT_MACHINE (@scalius/shared/shipment-state) over
// the shipments `where` selects that are still in one of the move's source
// states. A courier report a settled shipment refuses, or one that lands on a
// shipment held for staff, changes nothing, and so does a writer that lost a
// race to another. state-writers.test.ts holds every writer to it.
import { and, inArray, sql, type SQL } from "drizzle-orm";
import { deliveryShipments } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
    shipmentMoveTo,
    SHIPMENT_MACHINE,
    type ShipmentActor,
    type ShipmentStatus,
} from "@scalius/shared/shipment-state";

type ShipmentColumns = typeof deliveryShipments.$inferInsert;
type ShipmentExtra = { [K in Exclude<keyof ShipmentColumns, "status" | "id">]?: ShipmentColumns[K] | SQL };

/** The source states of `by` writing `to`: a declared move's, the target included when it is a report of the state the shipment is in. Throws for a write no move declares (a programming error). */
export function shipmentMoveSources(to: ShipmentStatus, by: ShipmentActor): readonly ShipmentStatus[] {
    const name = shipmentMoveTo(to, by);
    if (!name) throw new Error(`No ${by} move of the shipment machine reaches "${to}".`);
    return SHIPMENT_MACHINE.moves[name].from;
}

/** The WHERE part that holds a write of `to` by `by` to the declaration. */
export function shipmentMoveCondition(to: ShipmentStatus, by: ShipmentActor): SQL {
    return inArray(deliveryShipments.status, [...shipmentMoveSources(to, by)]);
}

/**
 * The update writing `to` by `by` over the shipments `where` selects, only
 * from the move's source states. `updatedAt` is now unless the caller sets it.
 */
export function shipmentMove(
    db: Database,
    to: ShipmentStatus,
    by: ShipmentActor,
    where: SQL | undefined,
    extra: ShipmentExtra = {},
) {
    return db.update(deliveryShipments).set({
        updatedAt: sql`unixepoch()`,
        ...extra,
        status: to,
    }).where(and(shipmentMoveCondition(to, by), where));
}
