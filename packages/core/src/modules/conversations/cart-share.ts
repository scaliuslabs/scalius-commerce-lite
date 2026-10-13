import type { Database } from "@scalius/database/client";
import { conversationCartShares } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { ConflictError, ValidationError } from "../../errors";
import { MAX_ORDER_LINE_ITEMS } from "../orders";
import { resolveBuyerThread } from "./threads";
import type { ConversationActor } from "./types";

export interface CartShareLine {
  productId: string;
  skuId: string;
  quantity: number;
  /** Server-resolved labels only; buyer requests contain identities and quantity. */
  title?: string;
  variantLabel?: string | null;
}

export interface ConversationCartShare {
  lines: CartShareLine[];
  sharedAt: number;
  withdrawnAt: number | null;
  version: number;
}

const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_QUANTITY = 99;

function normalizeId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ID_SHAPE.test(id)) throw new ValidationError("Choose a valid product and SKU to share.");
  return id;
}

export function normalizeCartShareLines(lines: readonly CartShareLine[]): CartShareLine[] {
  if (!Array.isArray(lines)) throw new ValidationError("Provide the cart items to share.");
  const bySku = new Map<string, CartShareLine>();
  for (const line of lines) {
    if (!line || typeof line !== "object") throw new ValidationError("Provide a valid cart item.");
    const productId = normalizeId(line.productId);
    const skuId = normalizeId(line.skuId);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
      throw new ValidationError(`Each shared item must have a quantity from 1 to ${MAX_QUANTITY}.`);
    }
    const existing = bySku.get(skuId);
    if (existing && existing.productId !== productId) {
      throw new ValidationError("A SKU cannot belong to different products in the shared cart.");
    }
    const quantity = (existing?.quantity ?? 0) + line.quantity;
    if (quantity > MAX_QUANTITY) {
      throw new ValidationError(`Each shared item must have a quantity from 1 to ${MAX_QUANTITY}.`);
    }
    if (line.title !== undefined && (typeof line.title !== "string" || [...line.title].length > 160)) {
      throw new ValidationError("The shared product title is too long.");
    }
    if (line.variantLabel !== undefined && line.variantLabel !== null
      && (typeof line.variantLabel !== "string" || [...line.variantLabel].length > 80)) {
      throw new ValidationError("The shared variant label is too long.");
    }
    bySku.set(skuId, {
      productId, skuId, quantity,
      ...(line.title === undefined ? {} : { title: line.title }),
      ...(line.variantLabel === undefined ? {} : { variantLabel: line.variantLabel }),
    });
    if (bySku.size > MAX_ORDER_LINE_ITEMS) {
      throw new ValidationError(`Share at most ${MAX_ORDER_LINE_ITEMS} different items.`);
    }
  }
  return [...bySku.values()];
}

function assertVersion(version: number, minimum: number): void {
  if (!Number.isSafeInteger(version) || version < minimum || version >= Number.MAX_SAFE_INTEGER) {
    throw new ValidationError("Provide the current shared cart version.");
  }
}

function view(row: typeof conversationCartShares.$inferSelect): ConversationCartShare {
  return {
    lines: JSON.parse(row.linesJson) as CartShareLine[],
    sharedAt: row.sharedAt,
    withdrawnAt: row.withdrawnAt,
    version: row.version,
  };
}

/** The caller authorizes reads through the buyer thread or staff conversation permission. */
export async function readConversationCartShare(db: Database, conversationId: string): Promise<ConversationCartShare | null> {
  const row = await db.select().from(conversationCartShares)
    .where(eq(conversationCartShares.conversationId, conversationId)).get();
  return row ? view(row) : null;
}

/** A consent snapshot only: no cart, order, thread status, message or notification writes. */
export async function shareConversationCart(
  db: Database,
  actor: ConversationActor,
  conversationId: string,
  input: { lines: readonly CartShareLine[]; expectedVersion: number },
): Promise<ConversationCartShare> {
  await resolveBuyerThread(db, actor, conversationId);
  assertVersion(input.expectedVersion, 0);
  const linesJson = JSON.stringify(normalizeCartShareLines(input.lines));
  const sharedAt = Math.floor(Date.now() / 1000);
  const [row] = input.expectedVersion === 0
    ? await db.insert(conversationCartShares).values({ conversationId, linesJson, sharedAt, version: 1 })
      .onConflictDoNothing({ target: conversationCartShares.conversationId }).returning()
    : await db.update(conversationCartShares).set({
      linesJson,
      sharedAt,
      withdrawnAt: null,
      version: sql`${conversationCartShares.version} + 1`,
    }).where(and(
      eq(conversationCartShares.conversationId, conversationId),
      eq(conversationCartShares.version, input.expectedVersion),
    )).returning();
  if (!row) throw new ConflictError("The shared cart changed. Refresh it before sharing again.");
  return view(row);
}

/** Keep an empty tombstone so stale updates cannot silently restore withdrawn consent. */
export async function withdrawConversationCart(
  db: Database,
  actor: ConversationActor,
  conversationId: string,
  expectedVersion: number,
): Promise<ConversationCartShare> {
  await resolveBuyerThread(db, actor, conversationId);
  assertVersion(expectedVersion, 1);
  const [row] = await db.update(conversationCartShares).set({
    linesJson: "[]",
    withdrawnAt: Math.floor(Date.now() / 1000),
    version: sql`${conversationCartShares.version} + 1`,
  }).where(and(
    eq(conversationCartShares.conversationId, conversationId),
    eq(conversationCartShares.version, expectedVersion),
  )).returning();
  if (!row) throw new ConflictError("The shared cart changed. Refresh it before withdrawing it.");
  return view(row);
}
