import { trimTrailingCharacters } from "@scalius/shared/text-scan";
// Warranty policies (Wave B §5.1): reusable, with immutable revisions. A
// create inserts the policy and revision 1 in one batch; an edit that changes
// any buyer-facing field inserts the next revision and points the policy at
// it in one batch, guarded by the version the editor loaded. Order lines keep
// the revision they froze at commit, so an edit never changes what a buyer
// bought. Archiving hides the policy from buyers and new products (the PDP
// and checkout ignore archived policies); revisions are never deleted.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch, chunkForD1 } from "@scalius/database/client";
import { products, productVariants, warrantyPolicies, warrantyPolicyRevisions } from "@scalius/database/schema";
import {
  WARRANTY_LIMITS,
  isWarrantyDurationKind,
  isWarrantyDurationValue,
  isWarrantyProvider,
  isWarrantyReplacementDays,
  readWarrantyDuration,
  storedWarrantyDuration,
  type WarrantyDurationKind,
  type WarrantyProvider,
} from "@scalius/shared/warranty";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { codePoints, nowSeconds, type BatchStatement } from "./shared";
import { formatNumber } from "@scalius/shared/locale-format";

const POLICY_CONFLICT = "warranty_policy_changed";
/** Stores keep a handful of policies; the list is bounded all the same. */
const POLICY_LIST_MAX = 200;

export interface WarrantyPolicyInput {
  name: string;
  provider: WarrantyProvider;
  /** 1 to 120; null for a lifetime warranty. */
  durationValue: number | null;
  /** A period unit, or `lifetime`: no end date, never expires. */
  durationUnit: WarrantyDurationKind;
  /** Days of free replacement from handover; null = none. */
  replacementDays: number | null;
  terms: string | null;
}

export interface WarrantyPolicyView extends WarrantyPolicyInput {
  id: string;
  currentRevisionId: string;
  /** The current revision's number (1 = never edited). */
  revision: number;
  archivedAt: number | null;
  version: number;
  /** Live (not deleted) products pointing at this policy. */
  productCount: number;
  createdAt: number;
  updatedAt: number;
}

function newPolicyId(): string {
  return `wrp_${nanoid(20)}`;
}

function newRevisionId(): string {
  return `wrr_${nanoid(20)}`;
}

/**
 * Validates and cleans a policy: trimmed name (1–80), a known provider, a
 * whole duration of 1–120 days, months or years or `lifetime` (its value is
 * null, whatever was sent), replacement 0–90 days or none (0 is kept as
 * none), and terms of at most 4,000 characters (blank = none).
 */
export function normalizeWarrantyPolicyInput(input: {
  name?: unknown;
  provider?: unknown;
  durationValue?: unknown;
  durationUnit?: unknown;
  replacementDays?: unknown;
  terms?: unknown;
}): WarrantyPolicyInput {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new ValidationError("Give the policy a name, like “1 year official warranty”.", { field: "name" });
  if (codePoints(name) > WARRANTY_LIMITS.nameLength) {
    throw new ValidationError(`Keep the name under ${WARRANTY_LIMITS.nameLength} characters.`, { field: "name" });
  }
  if (!isWarrantyProvider(input.provider)) {
    throw new ValidationError("Choose who honours the warranty: the brand or your store.", { field: "provider" });
  }
  if (!isWarrantyDurationKind(input.durationUnit)) {
    throw new ValidationError("Choose days, months, years or lifetime.", { field: "durationUnit" });
  }
  const lifetime = input.durationUnit === "lifetime";
  if (!lifetime && !isWarrantyDurationValue(input.durationValue)) {
    throw new ValidationError(
      `The warranty lasts ${WARRANTY_LIMITS.durationValue.min} to ${WARRANTY_LIMITS.durationValue.max} days, months or years, or a lifetime.`,
      { field: "durationValue" },
    );
  }
  let replacementDays: number | null = null;
  if (input.replacementDays !== null && input.replacementDays !== undefined) {
    if (!isWarrantyReplacementDays(input.replacementDays)) {
      throw new ValidationError(
        `Replacement lasts up to ${WARRANTY_LIMITS.replacementDays.max} days.`,
        { field: "replacementDays" },
      );
    }
    replacementDays = input.replacementDays === 0 ? null : input.replacementDays;
  }
  let terms: string | null = null;
  if (typeof input.terms === "string") {
    const cleaned = input.terms.replace(/\r\n?/g, "\n")
      .split(/([\n\u2028\u2029])/u)
      .map((line) => trimTrailingCharacters(line, (character) => character === " " || character === "\t"))
      .join("").trim();
    if (codePoints(cleaned) > WARRANTY_LIMITS.termsLength) {
      throw new ValidationError(`Keep the terms under ${formatNumber(WARRANTY_LIMITS.termsLength, "en")} characters.`, { field: "terms" });
    }
    terms = cleaned || null;
  } else if (input.terms !== null && input.terms !== undefined) {
    throw new ValidationError("Terms are plain text.", { field: "terms" });
  }
  return {
    name,
    provider: input.provider,
    durationValue: lifetime ? null : input.durationValue as number,
    durationUnit: input.durationUnit,
    replacementDays,
    terms,
  };
}

/** A normalized policy's columns as stored (lifetime as `WARRANTY_LIFETIME_STORAGE`). */
export function warrantyPolicyColumns(policy: WarrantyPolicyInput) {
  return {
    name: policy.name,
    provider: policy.provider,
    ...storedWarrantyDuration(policy),
    replacementDays: policy.replacementDays,
    terms: policy.terms,
  };
}

const policySelect = {
  id: warrantyPolicies.id,
  name: warrantyPolicies.name,
  provider: warrantyPolicies.provider,
  durationValue: warrantyPolicies.durationValue,
  durationUnit: warrantyPolicies.durationUnit,
  lifetime: warrantyPolicies.lifetime,
  replacementDays: warrantyPolicies.replacementDays,
  terms: warrantyPolicies.terms,
  currentRevisionId: warrantyPolicies.currentRevisionId,
  revision: sql<number>`coalesce(${warrantyPolicyRevisions.revision}, 1)`,
  archivedAt: warrantyPolicies.archivedAt,
  version: warrantyPolicies.version,
  createdAt: warrantyPolicies.createdAt,
  updatedAt: warrantyPolicies.updatedAt,
};

/**
 * Live products per policy: products that name it, plus products that name
 * another (or none) but have a live SKU that names it (the partial indexes on
 * both `warranty_policy_id` columns).
 */
async function productCounts(db: Database, policyIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const add = (policyId: string | null, count: number) => {
    if (policyId) counts.set(policyId, (counts.get(policyId) ?? 0) + (Number(count) || 0));
  };
  for (const chunk of chunkForD1(policyIds)) {
    const direct = await db
      .select({ policyId: products.warrantyPolicyId, count: sql<number>`count(*)` })
      .from(products)
      .where(and(inArray(products.warrantyPolicyId, chunk), isNull(products.deletedAt)))
      .groupBy(products.warrantyPolicyId)
      .all();
    for (const row of direct) add(row.policyId, row.count);
    const throughSkus = await db
      .select({ policyId: productVariants.warrantyPolicyId, count: sql<number>`count(DISTINCT ${productVariants.productId})` })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(
        inArray(productVariants.warrantyPolicyId, chunk),
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        sql`(${products.warrantyPolicyId} IS NULL OR ${products.warrantyPolicyId} <> ${productVariants.warrantyPolicyId})`,
      ))
      .groupBy(productVariants.warrantyPolicyId)
      .all();
    for (const row of throughSkus) add(row.policyId, row.count);
  }
  return counts;
}

type PolicyRow = Omit<WarrantyPolicyView, "productCount" | "durationValue" | "durationUnit"> & {
  durationValue: number;
  durationUnit: string;
  lifetime: number;
};

function present(row: PolicyRow, productCount: number): WarrantyPolicyView {
  const { lifetime, ...rest } = row;
  return {
    ...rest,
    ...readWarrantyDuration({ durationValue: row.durationValue, durationUnit: row.durationUnit, lifetime }),
    provider: row.provider as WarrantyProvider,
    revision: Number(row.revision) || 1,
    productCount,
  };
}

/** The store's own policies: an app's coverage plans (`app_id`) are its own, never listed or edited here. */
const storePolicy = isNull(warrantyPolicies.appId);

/** Live policies by name (archived ones too when asked), each with its product count. */
export async function listWarrantyPolicies(
  db: Database,
  options: { includeArchived?: boolean } = {},
): Promise<WarrantyPolicyView[]> {
  const rows = await db
    .select(policySelect)
    .from(warrantyPolicies)
    .leftJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, warrantyPolicies.currentRevisionId))
    .where(options.includeArchived ? storePolicy : and(storePolicy, isNull(warrantyPolicies.archivedAt)))
    .orderBy(sql`${warrantyPolicies.archivedAt} IS NOT NULL`, asc(sql`lower(${warrantyPolicies.name})`), asc(warrantyPolicies.id))
    .limit(POLICY_LIST_MAX)
    .all();
  const counts = await productCounts(db, rows.map((row) => row.id));
  return rows.map((row) => present(row as PolicyRow, counts.get(row.id) ?? 0));
}

export async function getWarrantyPolicy(db: Database, policyId: string): Promise<WarrantyPolicyView> {
  const row = await db
    .select(policySelect)
    .from(warrantyPolicies)
    .leftJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, warrantyPolicies.currentRevisionId))
    .where(and(eq(warrantyPolicies.id, policyId), storePolicy))
    .get();
  if (!row) throw new NotFoundError("Warranty policy not found");
  const counts = await productCounts(db, [row.id]);
  return present(row as PolicyRow, counts.get(row.id) ?? 0);
}

/** A new policy and its revision 1, in one batch. */
export async function createWarrantyPolicy(db: Database, input: WarrantyPolicyInput): Promise<WarrantyPolicyView> {
  const policy = normalizeWarrantyPolicyInput(input);
  const id = newPolicyId();
  const revisionId = newRevisionId();
  const now = nowSeconds();
  const columns = warrantyPolicyColumns(policy);
  await safeBatch(db, [
    db.insert(warrantyPolicies).values({ id, ...columns, currentRevisionId: revisionId, version: 1, createdAt: now, updatedAt: now }),
    db.insert(warrantyPolicyRevisions).values({ id: revisionId, policyId: id, revision: 1, ...columns, createdAt: now }),
  ] as unknown as readonly BatchStatement[]);
  return getWarrantyPolicy(db, id);
}

export function sameWarrantyTerms(a: WarrantyPolicyInput, b: WarrantyPolicyInput): boolean {
  return a.name === b.name
    && a.provider === b.provider
    && a.durationValue === b.durationValue
    && a.durationUnit === b.durationUnit
    && (a.replacementDays ?? null) === (b.replacementDays ?? null)
    && (a.terms ?? null) === (b.terms ?? null);
}

/**
 * Edits a live policy against the version the editor loaded. Any change makes
 * the next revision (new orders freeze it; earlier orders keep theirs). An
 * unchanged save writes nothing.
 */
export async function updateWarrantyPolicy(
  db: Database,
  policyId: string,
  input: WarrantyPolicyInput & { version: number },
): Promise<WarrantyPolicyView> {
  const next = normalizeWarrantyPolicyInput(input);
  const current = await getWarrantyPolicy(db, policyId);
  if (current.version !== input.version) throw staleEdit();
  if (current.archivedAt !== null) {
    throw new ValidationError("Restore this policy before editing it.");
  }
  if (sameWarrantyTerms(current, next)) return current;

  const revisionId = newRevisionId();
  const now = nowSeconds();
  try {
    await safeBatch(db, [
      buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${warrantyPolicies}
        WHERE ${warrantyPolicies.id} = ${policyId}
          AND ${warrantyPolicies.version} = ${input.version}
          AND ${warrantyPolicies.archivedAt} IS NULL
          AND ${warrantyPolicies.appId} IS NULL
      )`, POLICY_CONFLICT),
      db.insert(warrantyPolicyRevisions).values({
        id: revisionId,
        policyId,
        revision: current.revision + 1,
        ...warrantyPolicyColumns(next),
        createdAt: now,
      }),
      db.update(warrantyPolicies).set({
        ...warrantyPolicyColumns(next),
        currentRevisionId: revisionId,
        version: sql`${warrantyPolicies.version} + 1`,
        updatedAt: now,
      }).where(and(eq(warrantyPolicies.id, policyId), eq(warrantyPolicies.version, input.version))),
    ] as unknown as readonly BatchStatement[]);
  } catch (error) {
    if (isBatchGuardError(error, POLICY_CONFLICT) || /warranty_policy_revisions_policy_revision_unique|UNIQUE/i.test(String(error))) {
      throw staleEdit();
    }
    throw error;
  }
  return getWarrantyPolicy(db, policyId);
}

function staleEdit() {
  return new ConflictError("This policy changed since you opened it. Reload and try again.");
}

/**
 * Hides a policy from buyers and the product editor. Products keep their
 * reference but show and sell without a warranty until they get another
 * policy; orders keep the revision they froze. Idempotent.
 */
export async function archiveWarrantyPolicy(db: Database, policyId: string): Promise<WarrantyPolicyView> {
  const now = nowSeconds();
  await db.update(warrantyPolicies).set({
    archivedAt: now,
    version: sql`${warrantyPolicies.version} + 1`,
    updatedAt: now,
  }).where(and(eq(warrantyPolicies.id, policyId), storePolicy, isNull(warrantyPolicies.archivedAt)));
  return getWarrantyPolicy(db, policyId);
}

/** Brings an archived policy back; products still pointing at it show it again. Idempotent. */
export async function restoreWarrantyPolicy(db: Database, policyId: string): Promise<WarrantyPolicyView> {
  const now = nowSeconds();
  await db.update(warrantyPolicies).set({
    archivedAt: null,
    version: sql`${warrantyPolicies.version} + 1`,
    updatedAt: now,
  }).where(and(eq(warrantyPolicies.id, policyId), storePolicy, isNotNull(warrantyPolicies.archivedAt)));
  return getWarrantyPolicy(db, policyId);
}
