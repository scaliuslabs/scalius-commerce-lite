// Suppliers (migration 0109): who the merchant buys from. Minimal records
// (name, contact, phone, email, notes) that purchase orders point at;
// archived rather than deleted so past purchase orders keep their supplier.

import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Database } from "@scalius/database/client";
import { purchaseOrders, suppliers, SUPPLIER_STATUSES, type SupplierStatus } from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { blankToNull, optionalTextSchema, parseInventoryInput } from "./validation";


export const supplierInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120),
  contactName: optionalTextSchema(120),
  phone: optionalTextSchema(32),
  email: z.union([z.string().trim().email("Enter a valid email.").max(254), z.literal("")]).nullable().optional(),
  notes: optionalTextSchema(2000),
});
export type SupplierInput = z.input<typeof supplierInputSchema>;

export const updateSupplierSchema = supplierInputSchema.extend({
  expectedVersion: z.number().int().min(1),
});
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>;

export const listSuppliersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum([...SUPPLIER_STATUSES, "all"]).optional().default("active"),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListSuppliersQuery = z.input<typeof listSuppliersQuerySchema>;

export interface SupplierRecord {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: SupplierStatus;
  version: number;
  /** Purchase orders still expected from this supplier (ordered or partially received). */
  openPurchaseOrders: number;
  createdAt: Date;
  updatedAt: Date;
}

function values(input: z.output<typeof supplierInputSchema>) {
  return {
    name: input.name,
    contactName: blankToNull(input.contactName),
    phone: blankToNull(input.phone),
    email: blankToNull(input.email),
    notes: blankToNull(input.notes),
  };
}

// Correlated on the outer supplier row, qualified explicitly: drizzle renders
// a single-table select's columns without their table name.
const openOrdersSql = sql<number>`(
  SELECT count(*) FROM ${purchaseOrders} AS open_po
  WHERE open_po.supplier_id = ${sql.raw('"suppliers"."id"')}
    AND open_po.status IN ('ordered', 'partially_received')
)`;

const supplierFields = {
  id: suppliers.id,
  name: suppliers.name,
  contactName: suppliers.contactName,
  phone: suppliers.phone,
  email: suppliers.email,
  notes: suppliers.notes,
  status: suppliers.status,
  version: suppliers.version,
  openPurchaseOrders: openOrdersSql,
  createdAt: suppliers.createdAt,
  updatedAt: suppliers.updatedAt,
};

export async function listSuppliers(db: Database, query: ListSuppliersQuery = {}) {
  const { q, status, page, limit } = parseInventoryInput(listSuppliersQuerySchema, query, "Invalid supplier");
  const conditions: SQL[] = [];
  if (status !== "all") conditions.push(eq(suppliers.status, status));
  if (q) {
    conditions.push(or(containsText(suppliers.name, q), containsText(suppliers.contactName, q), containsText(suppliers.phone, q), containsText(suppliers.email, q))!);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, counts] = await db.batch([
    db.select(supplierFields).from(suppliers).where(where)
      .orderBy(asc(suppliers.status), asc(sql`lower(${suppliers.name})`), asc(suppliers.id))
      .limit(limit).offset((page - 1) * limit),
    db.select({ total: sql<number>`count(*)` }).from(suppliers).where(where),
  ]);
  const total = Number(counts[0]?.total ?? 0);
  return {
    suppliers: rows.map((row) => ({ ...row, openPurchaseOrders: Number(row.openPurchaseOrders) })) as SupplierRecord[],
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getSupplier(db: Database, id: string): Promise<SupplierRecord> {
  const row = await db.select(supplierFields).from(suppliers).where(eq(suppliers.id, id)).get();
  if (!row) throw new NotFoundError("Supplier not found");
  return { ...row, openPurchaseOrders: Number(row.openPurchaseOrders) } as SupplierRecord;
}

export async function createSupplier(db: Database, input: SupplierInput): Promise<SupplierRecord> {
  const data = values(parseInventoryInput(supplierInputSchema, input, "Invalid supplier"));
  const id = `sup_${nanoid(16)}`;
  await db.insert(suppliers).values({
    id,
    ...data,
    status: "active",
    version: 1,
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  });
  return getSupplier(db, id);
}

export async function updateSupplier(db: Database, id: string, input: UpdateSupplierInput): Promise<SupplierRecord> {
  const { expectedVersion, ...fields } = parseInventoryInput(updateSupplierSchema, input, "Invalid supplier");
  const updated = await db.update(suppliers).set({
    ...values(fields),
    version: sql`${suppliers.version} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(suppliers.id, id), eq(suppliers.version, expectedVersion))).returning({ id: suppliers.id });
  if (updated.length === 0) {
    await getSupplier(db, id);
    throw new ConflictError("This supplier changed. Reload to see the latest.");
  }
  return getSupplier(db, id);
}

/** Archives a supplier; refused while purchase orders are still expected from it. */
export async function archiveSupplier(db: Database, id: string): Promise<SupplierRecord> {
  const archived = await db.update(suppliers).set({
    status: "archived",
    version: sql`${suppliers.version} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(suppliers.id, id),
    eq(suppliers.status, "active"),
    sql`NOT EXISTS (
      SELECT 1 FROM ${purchaseOrders}
      WHERE ${purchaseOrders.supplierId} = ${id}
        AND ${purchaseOrders.status} IN ('ordered', 'partially_received')
    )`,
  )).returning({ id: suppliers.id });
  const supplier = await getSupplier(db, id);
  if (archived.length > 0 || supplier.status === "archived") return supplier;
  throw new ConflictError(`Purchase orders are still expected from ${supplier.name}. Receive or cancel them first.`);
}

export async function unarchiveSupplier(db: Database, id: string): Promise<SupplierRecord> {
  await db.update(suppliers).set({
    status: "active",
    version: sql`${suppliers.version} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(suppliers.id, id), eq(suppliers.status, "archived")));
  return getSupplier(db, id);
}

/** An active supplier a purchase order can name (or a clear error). */
export async function assertActiveSupplier(db: Database, id: string): Promise<{ id: string; name: string }> {
  const row = await db.select({ id: suppliers.id, name: suppliers.name, status: suppliers.status })
    .from(suppliers).where(eq(suppliers.id, id)).get();
  if (!row) throw new NotFoundError("Supplier not found");
  if (row.status !== "active") throw new ValidationError(`${row.name} is archived. Choose an active supplier.`);
  return { id: row.id, name: row.name };
}
