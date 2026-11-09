// App coverage on the store's own warranty records (COMMERCE-HOOKS H21). An
// app that sells protection issues one native warranty record per protected
// unit of an order line, under its own plan (an app-owned policy keyed by the
// app's plan key, revisioned like the store's), and voids units when they are
// cancelled, refunded or returned. Buyers see and claim them as any warranty
// (account Warranties, the order, receipt proof); staff manage the claims.
//
// Both writes set a target, so a repeat (any key, an event delivered twice or
// out of order) changes nothing twice:
// - issue: the line holds `quantity` of the app's records (voided ones count:
//   a refunded unit is never covered again by a late event);
// - void: at least `quantity` of them are voided (a refund and a return of the
//   same unit, each counted from the order as it is now, void it once).
// The events (`warranty.issued`, `warranty.voided`) come from the table's
// triggers. A record's `code` is random, checked unique by its index; a
// collision draws again.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, chunkForD1, isBatchGuardError, safeBatch } from "@scalius/database/client";
import {
  orderItemWarranties,
  orderItems,
  orders,
  warrantyClaims,
  warrantyPolicies,
  warrantyPolicyRevisions,
} from "@scalius/database/schema";
import type { EventRepresentation } from "@scalius/shared/events";
import { buildEventRepresentation } from "@scalius/shared/events";
import {
  isWarrantyActive,
  newWarrantyCode,
  readWarrantyDuration,
  warrantyEndsAt,
  type WarrantyDurationKind,
} from "@scalius/shared/warranty";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AppError, NotFoundError, ValidationError } from "../../errors";
import { normalizeWarrantyPolicyInput, sameWarrantyTerms, warrantyPolicyColumns, type WarrantyPolicyInput } from "./policies";
import { nowSeconds, type BatchStatement } from "./shared";

/** The most units of one line an app covers (and the most one call issues or voids). */
export const APP_WARRANTY_UNITS_MAX = 100;
const PLAN_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CODE_ATTEMPTS = 4;
const PLAN_CHANGED = "warranty_plan_changed";

/** An app's plan as `warranties.issue` names it: its key and the terms it freezes. */
export interface AppWarrantyPlanInput {
  key: string;
  name: string;
  durationValue: number | null;
  durationUnit: WarrantyDurationKind;
  terms: string | null;
}

export interface IssueAppWarrantiesInput {
  appId: string;
  orderItemId: string;
  /** The units of the line the app covers in all (1 to the line's quantity). */
  quantity: number;
  plan: AppWarrantyPlanInput;
}

export interface VoidAppWarrantiesInput {
  appId: string;
  orderItemId: string;
  /** The units of the line whose coverage has ended in all (0 to what the app issued). */
  quantity: number;
}

export type WarrantyRepresentation = EventRepresentation<"warranty">;

function coverageError(code: string, message: string, status = 409): AppError {
  return new AppError(status, code, message);
}

function assertUnits(quantity: unknown, field: string, minimum: number): number {
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < minimum || quantity > APP_WARRANTY_UNITS_MAX) {
    throw new ValidationError(`Name ${minimum} to ${APP_WARRANTY_UNITS_MAX} units.`, { field });
  }
  return quantity;
}

function normalizePlan(plan: AppWarrantyPlanInput): { key: string; policy: WarrantyPolicyInput } {
  if (typeof plan?.key !== "string" || !PLAN_KEY.test(plan.key)) {
    throw new ValidationError("A plan key is 1 to 64 lowercase letters, digits, hyphens or underscores.", { field: "policy.key" });
  }
  const policy = normalizeWarrantyPolicyInput({
    name: plan.name,
    provider: "store",
    durationValue: plan.durationValue,
    durationUnit: plan.durationUnit,
    replacementDays: null,
    terms: plan.terms,
  });
  return { key: plan.key, policy };
}

interface CoverableLine {
  orderId: string;
  orderItemId: string;
  quantity: number;
  fulfillmentType: string;
  status: string;
}

async function readCoverableLine(db: Database, orderItemId: string): Promise<CoverableLine> {
  const line = await db
    .select({
      orderId: orderItems.orderId,
      orderItemId: orderItems.id,
      quantity: orderItems.quantity,
      fulfillmentType: orderItems.fulfillmentType,
      status: orders.status,
    })
    .from(orderItems)
    .innerJoin(orders, and(eq(orders.id, orderItems.orderId), isNull(orders.deletedAt)))
    .where(eq(orderItems.id, orderItemId))
    .get();
  if (!line) throw new NotFoundError("Order line not found");
  return line;
}

/**
 * The app's plan's current revision: created with revision 1 the first time,
 * a new revision when the terms changed (earlier records keep theirs).
 */
async function currentPlanRevision(db: Database, appId: string, key: string, policy: WarrantyPolicyInput): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await db
      .select({
        id: warrantyPolicies.id,
        version: warrantyPolicies.version,
        currentRevisionId: warrantyPolicies.currentRevisionId,
        name: warrantyPolicies.name,
        provider: warrantyPolicies.provider,
        durationValue: warrantyPolicies.durationValue,
        durationUnit: warrantyPolicies.durationUnit,
        lifetime: warrantyPolicies.lifetime,
        replacementDays: warrantyPolicies.replacementDays,
        terms: warrantyPolicies.terms,
        revision: warrantyPolicyRevisions.revision,
      })
      .from(warrantyPolicies)
      .innerJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, warrantyPolicies.currentRevisionId))
      .where(and(eq(warrantyPolicies.appId, appId), eq(warrantyPolicies.appKey, key)))
      .get();
    const columns = warrantyPolicyColumns(policy);
    const now = nowSeconds();
    if (!current) {
      const id = `wrp_${nanoid(20)}`;
      const revisionId = `wrr_${nanoid(20)}`;
      try {
        await safeBatch(db, [
          db.insert(warrantyPolicies).values({ id, ...columns, appId, appKey: key, currentRevisionId: revisionId, version: 1, createdAt: now, updatedAt: now }),
          db.insert(warrantyPolicyRevisions).values({ id: revisionId, policyId: id, revision: 1, ...columns, createdAt: now }),
        ] as unknown as readonly BatchStatement[]);
        return revisionId;
      } catch (error) {
        // Another call created the plan first: read it again.
        if (/warranty_policies_app_key_unique|UNIQUE|duplicate key/i.test(String(error))) continue;
        throw error;
      }
    }
    const stored: WarrantyPolicyInput = {
      name: current.name,
      provider: current.provider as WarrantyPolicyInput["provider"],
      ...readWarrantyDuration(current),
      replacementDays: current.replacementDays,
      terms: current.terms,
    };
    if (sameWarrantyTerms(stored, policy)) return current.currentRevisionId;
    const revisionId = `wrr_${nanoid(20)}`;
    try {
      await safeBatch(db, [
        buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${warrantyPolicies} WHERE ${warrantyPolicies.id} = ${current.id} AND ${warrantyPolicies.version} = ${current.version})`, PLAN_CHANGED),
        db.insert(warrantyPolicyRevisions).values({ id: revisionId, policyId: current.id, revision: Number(current.revision) + 1, ...columns, createdAt: now }),
        db.update(warrantyPolicies).set({ ...columns, currentRevisionId: revisionId, version: sql`${warrantyPolicies.version} + 1`, updatedAt: now })
          .where(and(eq(warrantyPolicies.id, current.id), eq(warrantyPolicies.version, current.version))),
      ] as unknown as readonly BatchStatement[]);
      return revisionId;
    } catch (error) {
      if (isBatchGuardError(error, PLAN_CHANGED) || /warranty_policy_revisions_policy_revision_unique|UNIQUE|duplicate key/i.test(String(error))) continue;
      throw error;
    }
  }
  throw coverageError("warranty_plan_conflict", "The plan changed while it was being saved. Try again.");
}

interface AppRecordRow {
  id: string;
  unitNumber: number | null;
  voidedAt: number | null;
}

async function appRecordsOfLine(db: Database, appId: string, orderItemId: string): Promise<AppRecordRow[]> {
  return await db
    .select({ id: orderItemWarranties.id, unitNumber: orderItemWarranties.unitNumber, voidedAt: orderItemWarranties.voidedAt })
    .from(orderItemWarranties)
    .where(and(eq(orderItemWarranties.orderItemId, orderItemId), eq(orderItemWarranties.appId, appId)))
    .orderBy(asc(orderItemWarranties.unitNumber))
    .all();
}

function isUniqueViolation(error: unknown, index: string): boolean {
  const text = `${String(error)} ${String((error as { cause?: unknown })?.cause ?? "")}`;
  return text.includes(index) || (/UNIQUE constraint failed: order_item_warranties\.code/i.test(text) && index === "order_item_warranties_code_unique")
    || (/UNIQUE constraint failed: order_item_warranties\.order_item_id/i.test(text) && index === "order_item_warranties_app_unit_unique");
}

/**
 * Covers units of an order line with the app's plan: the line ends with
 * `quantity` of the app's records (voided ones count), each new one starting
 * now and ending by the plan (never, for a lifetime plan). Refused on a gift
 * card line, a cancelled order, or past the line's quantity.
 */
export async function issueAppWarranties(
  db: Database,
  input: IssueAppWarrantiesInput,
  options: { now?: number } = {},
): Promise<{ warranties: WarrantyRepresentation[]; issued: number }> {
  const quantity = assertUnits(input.quantity, "quantity", 1);
  const { key, policy } = normalizePlan(input.plan);
  const line = await readCoverableLine(db, input.orderItemId);
  if (line.fulfillmentType === "gift_card") {
    throw coverageError("warranty_line_not_coverable", "A gift card takes no warranty.", 422);
  }
  if (line.status === "cancelled") {
    throw coverageError("warranty_order_cancelled", "This order was cancelled: its lines take no new coverage.");
  }
  if (quantity > line.quantity) {
    throw new ValidationError(`The line has ${line.quantity} unit${line.quantity === 1 ? "" : "s"}.`, { field: "quantity" });
  }
  const revisionId = await currentPlanRevision(db, input.appId, key, policy);
  let issued = 0;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const existing = await appRecordsOfLine(db, input.appId, input.orderItemId);
    const needed = quantity - existing.length;
    if (needed <= 0) break;
    const firstUnit = existing.reduce((max, row) => Math.max(max, row.unitNumber ?? 0), 0) + 1;
    const now = options.now ?? nowSeconds();
    const expiresAt = warrantyEndsAt(now, policy);
    const rows = Array.from({ length: needed }, (_, index) => ({
      id: `wty_${nanoid(24)}`,
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      revisionId,
      quantity: 1,
      startsAt: now,
      expiresAt,
      replacementUntil: null,
      createdAt: now,
      appId: input.appId,
      unitNumber: firstUnit + index,
      code: newWarrantyCode(),
    }));
    // 12 bound values a row: six rows a statement stays under D1's 100.
    const statements: BatchStatement[] = [];
    for (let start = 0; start < rows.length; start += 6) {
      statements.push(db.insert(orderItemWarranties).values(rows.slice(start, start + 6)) as unknown as BatchStatement);
    }
    try {
      await safeBatch(db, statements as unknown as readonly BatchStatement[]);
      issued += needed;
      break;
    } catch (error) {
      // A code drawn twice, or another call issuing the same units: read the line again.
      if (isUniqueViolation(error, "order_item_warranties_code_unique") || isUniqueViolation(error, "order_item_warranties_app_unit_unique")) continue;
      throw error;
    }
  }
  return { warranties: await lineAppWarranties(db, input.appId, input.orderItemId), issued };
}

/**
 * Ends coverage of units of an order line: at least `quantity` of the app's
 * records on it are voided, newest unit first among those still active. A
 * claim already open on a voided record stays with staff.
 */
export async function voidAppWarranties(
  db: Database,
  input: VoidAppWarrantiesInput,
  options: { now?: number } = {},
): Promise<{ warranties: WarrantyRepresentation[]; voided: number }> {
  const quantity = assertUnits(input.quantity, "quantity", 0);
  await readCoverableLine(db, input.orderItemId);
  const records = await appRecordsOfLine(db, input.appId, input.orderItemId);
  const alreadyVoided = records.filter((row) => row.voidedAt !== null).length;
  const toVoid = records
    .filter((row) => row.voidedAt === null)
    .sort((left, right) => (right.unitNumber ?? 0) - (left.unitNumber ?? 0))
    .slice(0, Math.max(0, Math.min(quantity, records.length) - alreadyVoided))
    .map((row) => row.id);
  let voided = 0;
  if (toVoid.length > 0) {
    const now = options.now ?? nowSeconds();
    const result = await db.update(orderItemWarranties)
      .set({ voidedAt: now })
      .where(and(
        inArray(orderItemWarranties.id, sql`(SELECT value FROM json_each(${JSON.stringify(toVoid)}))`),
        isNull(orderItemWarranties.voidedAt),
      ))
      .run();
    voided = Number((result as { meta?: { changes?: number }; rowsAffected?: number }).meta?.changes
      ?? (result as { rowsAffected?: number }).rowsAffected ?? toVoid.length);
  }
  return { warranties: await lineAppWarranties(db, input.appId, input.orderItemId), voided };
}

async function lineAppWarranties(db: Database, appId: string, orderItemId: string): Promise<WarrantyRepresentation[]> {
  const ids = (await appRecordsOfLine(db, appId, orderItemId)).map((row) => row.id);
  return await readWarrantyRepresentations(db, ids);
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const isoOrNull = (seconds: number | null) => (seconds === null ? null : iso(seconds));

/**
 * The sealed `warranty` representations of records by id, in the order
 * given (missing ones left out), with each one's latest claim (an open one
 * first). Ids are read in waves of at most 90.
 */
export async function readWarrantyRepresentations(
  db: Database,
  ids: readonly string[],
  options: { now?: number } = {},
): Promise<WarrantyRepresentation[]> {
  if (ids.length === 0) return [];
  const now = options.now ?? nowSeconds();
  const byId = new Map<string, WarrantyRepresentation>();
  for (const chunk of chunkForD1([...new Set(ids)])) {
    const rows = await db
      .select({
        id: orderItemWarranties.id,
        code: orderItemWarranties.code,
        appId: orderItemWarranties.appId,
        orderId: orderItemWarranties.orderId,
        orderNumber: orders.orderNumber,
        orderItemId: orderItemWarranties.orderItemId,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        title: orderItems.productName,
        variantLabel: orderItems.variantLabel,
        unitNumber: orderItemWarranties.unitNumber,
        quantity: orderItemWarranties.quantity,
        startsAt: orderItemWarranties.startsAt,
        expiresAt: orderItemWarranties.expiresAt,
        replacementUntil: orderItemWarranties.replacementUntil,
        voidedAt: orderItemWarranties.voidedAt,
        createdAt: orderItemWarranties.createdAt,
        policyId: warrantyPolicyRevisions.policyId,
        policyKey: warrantyPolicies.appKey,
        revisionId: warrantyPolicyRevisions.id,
        revision: warrantyPolicyRevisions.revision,
        name: warrantyPolicyRevisions.name,
        provider: warrantyPolicyRevisions.provider,
        durationValue: warrantyPolicyRevisions.durationValue,
        durationUnit: warrantyPolicyRevisions.durationUnit,
        lifetime: warrantyPolicyRevisions.lifetime,
        replacementDays: warrantyPolicyRevisions.replacementDays,
        terms: warrantyPolicyRevisions.terms,
      })
      .from(orderItemWarranties)
      .innerJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, orderItemWarranties.revisionId))
      .innerJoin(warrantyPolicies, eq(warrantyPolicies.id, warrantyPolicyRevisions.policyId))
      .innerJoin(orders, eq(orders.id, orderItemWarranties.orderId))
      .innerJoin(orderItems, eq(orderItems.id, orderItemWarranties.orderItemId))
      .where(inArray(orderItemWarranties.id, sql`(SELECT value FROM json_each(${JSON.stringify(chunk)}))`))
      .all();
    const claims = await db
      .select({ id: warrantyClaims.id, warrantyId: warrantyClaims.warrantyId, status: warrantyClaims.status, resolution: warrantyClaims.resolution, createdAt: warrantyClaims.createdAt })
      .from(warrantyClaims)
      .where(inArray(warrantyClaims.warrantyId, sql`(SELECT value FROM json_each(${JSON.stringify(chunk)}))`))
      .orderBy(desc(warrantyClaims.createdAt), desc(warrantyClaims.id))
      .all();
    const latest = new Map<string, (typeof claims)[number]>();
    for (const claim of claims) {
      const current = latest.get(claim.warrantyId);
      const open = claim.status === "open" || claim.status === "in_progress";
      if (!current || (open && current.status !== "open" && current.status !== "in_progress")) latest.set(claim.warrantyId, claim);
    }
    for (const row of rows) {
      const claim = latest.get(row.id);
      byId.set(row.id, buildEventRepresentation("warranty", {
        id: row.id,
        code: row.code ?? null,
        appId: row.appId ?? null,
        orderId: row.orderId,
        orderNumber: row.orderNumber ?? null,
        orderItemId: row.orderItemId,
        item: { productId: row.productId ?? null, variantId: row.variantId ?? null, title: row.title ?? null, variantLabel: row.variantLabel ?? null },
        unitNumber: row.unitNumber ?? null,
        quantity: row.quantity,
        policy: {
          id: row.policyId,
          key: row.policyKey ?? null,
          revisionId: row.revisionId,
          revision: row.revision,
          name: row.name,
          provider: row.provider as "brand" | "store",
          ...readWarrantyDuration(row),
          replacementDays: row.replacementDays ?? null,
          terms: row.terms ?? null,
        },
        status: row.voidedAt !== null ? "voided" : isWarrantyActive(row, now) ? "active" : "expired",
        startsAt: iso(row.startsAt),
        expiresAt: isoOrNull(row.expiresAt),
        replacementUntil: isoOrNull(row.replacementUntil),
        voidedAt: isoOrNull(row.voidedAt),
        claim: claim ? { id: claim.id, status: claim.status, resolution: claim.resolution ?? null } : null,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.voidedAt ?? row.createdAt),
      }, new Set()));
    }
  }
  return ids.flatMap((id) => {
    const representation = byId.get(id);
    return representation ? [representation] : [];
  });
}
