// An erased customer (`eraseCustomer`) never regains personal data. Each
// staff writer of a customer's contact leads its batch with this guard, so an
// erasure that commits between the writer's read and its batch refuses the
// write as a conflict. The database refuses the same writes for every other
// writer (migration 0191's triggers raise the same marker).
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { customers } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import { ConflictError, NotFoundError } from "@scalius/core/errors";

/** The guard's marker, and the message migration 0191's triggers raise. */
export const CUSTOMER_ERASED = "CUSTOMER_ERASED";

/** Fails the batch unless the customer exists, is not erased and `also` holds for its row. */
export function customerNotErasedGuard(db: Database, customerId: string, also?: SQL) {
    return buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${customers}
        WHERE ${customers.id} = ${customerId} AND ${customers.erasedAt} IS NULL
        ${also ? sql`AND ${also}` : sql``}
    )`, CUSTOMER_ERASED);
}

/** The guard above or a 0191 trigger refused the write. */
export function isCustomerErasedError(error: unknown): boolean {
    return isBatchGuardError(error, CUSTOMER_ERASED);
}

/** The answer to a write on an erased customer (409). */
export function erasedCustomerConflict(message = "This customer's data was erased, so the record can't be changed."): ConflictError {
    return new ConflictError(message);
}

/**
 * Before a staff write on one customer: 409 when its data was erased (erasure
 * also trashes the record, so this is checked first), 404 when it is gone or
 * trashed.
 */
export function assertCustomerWritable(row: { erasedAt: unknown; deletedAt: unknown } | undefined): void {
  if (row?.erasedAt) throw erasedCustomerConflict();
  if (!row || row.deletedAt) throw new NotFoundError("Customer not found");
}
