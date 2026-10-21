// Bounded batch creates of the stable app API (operation-registry/README.md):
// `products.batch_create`, `categories.batch_create`, `brands.batch_create`.
// An importer or PIM sync creates many catalogue items per call instead of one
// request each. The three routes share this runner.
//
// - Each item is the exact body of the single create plus a client `key`
//   (1 to 64 printable characters, unique within the request). The whole
//   request shape is checked up front (400); nothing is created for a
//   malformed request.
// - Items run one after another in request order. An item that cannot be
//   created (a taken slug, an unknown category, an active product priced 0...)
//   is `failed` with the refusal's lower_snake code and never stops the others.
//   An unexpected fault (a 5xx) is not an item failure: it surfaces as the
//   request's own 5xx, and a retry replays the items already created.
// - Per-item idempotency: an item's id is derived from its key, scoped to the
//   caller and the operation (`scopedRequestKey`: another app or staff member
//   never shares a key), so the create and its retry key commit in the one
//   insert. A later call of the same caller with the same item key, whatever
//   its `Idempotency-Key` header, creates nothing: the item is `replayed` with
//   the resource's current ref, or `failed` (`not_found`) when it is in the
//   trash (permanently delete it, or use a new key). A Worker that dies after
//   the insert, and two concurrent calls with one key, still make one
//   resource: the second insert loses on the primary key and replays.
// - The response carries slim refs `{ id, slug, revision }` read once at the
//   end (so a replayed item shows the resource as it is now); read the full
//   resource with `products.get` and the like.
// - The bound is a plan value (`planLimits().batchCreates`): see the
//   measurement beside each route.
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { sha256Hex } from "@scalius/shared/hash";
import { AppError, ValidationError } from "@scalius/core/errors";
import { scopedRequestKey } from "./idempotency";

/** 1 to 64 printable ASCII characters (space included); opaque to the API. */
export const BATCH_ITEM_KEY_PATTERN = /^[\x20-\x7E]{1,64}$/u;
const MAX_ERROR_MESSAGE = 300;

export const batchItemKeySchema = z.string().regex(BATCH_ITEM_KEY_PATTERN, "key is 1 to 64 printable characters.").openapi({
  description: "Your name for this item (1 to 64 printable characters, unique in the request). Repeating a key returns the item created under it (`replayed`) instead of creating again.",
});

const refSchema = z.object({
  id: z.string().max(160),
  slug: z.string().max(160),
  revision: z.number().int().min(1),
});

export type BatchRef = z.infer<typeof refSchema>;

/** `{ items: [...] }` for one noun (`product`, `category`, `brand`): the request body of a batch create. */
export function batchRequestSchema<T extends z.ZodType>(item: T, maxItems: number) {
  return z.object({
    items: z.array(item).min(1).max(maxItems).openapi({
      description: "The items to create, each the single create's body plus `key`. At most the plan's bound per call (Free fewer than Paid): over it is refused with 400 and nothing is created.",
    }),
  }).strict();
}

/** The response data of a batch create: one result per request item, in request order. */
export function batchResultSchema<N extends string>(noun: N) {
  return z.object({
    items: z.array(z.object({
      key: z.string().max(64),
      outcome: z.enum(["created", "replayed", "failed"]).openapi({
        description: "`created` now; `replayed` was created earlier under this key (nothing was created); `failed` was refused, see `error` (the other items are unaffected).",
      }),
      [noun]: refSchema.nullable(),
      error: z.object({ code: z.string().max(64), message: z.string().max(MAX_ERROR_MESSAGE) }).nullable(),
    })).max(100),
  });
}

/** A batch create's response data for one noun, as `batchResultSchema(noun)` states it. */
export type BatchCreateData<N extends "product" | "category" | "brand"> = {
  items: Array<{ key: string; outcome: ItemOutcome; error: ItemError | null } & { [K in N]: BatchRef | null }>;
};

type ItemOutcome = "created" | "replayed" | "failed";
type ItemError = { code: string; message: string };
type Settled = { key: string; outcome: ItemOutcome; id: string | null; error: ItemError | null };

export interface BatchCreateSpec<Item extends { key: string }> {
  /** The stable operation id: the scope of the item keys. */
  operationId: string;
  noun: "product" | "category" | "brand";
  /** Plural noun for the over-bound message. */
  plural: string;
  /** The resource's id prefix (`prod_`, `cat_`, `brd_`): an item's id is this plus a digest of its scoped key. */
  idPrefix: string;
  items: readonly Item[];
  /** The plan's bound for this call. */
  bound: number;
  /** Creates one item under `id`. A refusal (an AppError below 500) fails only that item. */
  create: (item: Item, id: string) => Promise<unknown>;
  /** Which of these ids exist, live or in the trash (a create made them). */
  existing: (ids: readonly string[]) => Promise<Set<string>>;
  /** The live resources among these ids, by id. Trashed and deleted ones are absent. */
  readRefs: (ids: readonly string[]) => Promise<Map<string, BatchRef>>;
}

export interface BatchCreateResult {
  data: { items: Array<Record<string, unknown>> };
  /** Ids created by this call (not the replayed ones), for the caller's after-write work. */
  createdIds: string[];
}

function refusalOf(error: unknown): ItemError | null {
  if (!(error instanceof AppError) || error.status >= 500) return null;
  return { code: error.code, message: error.message.slice(0, MAX_ERROR_MESSAGE) };
}

/** The id an item key always creates: the resource prefix and 24 hex of the scoped key's digest. */
async function itemId(prefix: string, scopedKey: string): Promise<string> {
  return `${prefix}${(await sha256Hex(`batch-item\n${scopedKey}`)).slice(0, 24)}`;
}

/** Runs a batch create (see the file comment) and returns the response data. */
export async function runBatchCreate<Item extends { key: string }>(
  c: Context,
  spec: BatchCreateSpec<Item>,
): Promise<BatchCreateResult> {
  const { items } = spec;
  if (items.length > spec.bound) {
    throw new ValidationError(
      `This plan creates at most ${spec.bound} ${spec.plural} per call; send ${items.length} in ${Math.ceil(items.length / spec.bound)} calls.`,
      { field: "items", limit: spec.bound },
    );
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) {
      throw new ValidationError(`Item key "${item.key}" is used twice: every key in a request is unique.`, { field: "items.key" });
    }
    seen.add(item.key);
  }

  const ids = await Promise.all(items.map(async (item) => itemId(spec.idPrefix, await scopedRequestKey(c, spec.operationId, item.key))));
  const made = await spec.existing(ids);

  const settled: Settled[] = [];
  const createdIds: string[] = [];
  for (const [index, item] of items.entries()) {
    const id = ids[index]!;
    if (made.has(id)) {
      settled.push({ key: item.key, outcome: "replayed", id, error: null });
      continue;
    }
    try {
      await spec.create(item, id);
      createdIds.push(id);
      settled.push({ key: item.key, outcome: "created", id, error: null });
    } catch (error) {
      // A concurrent call (or a retry racing its first attempt) inserted this id first.
      if ((await spec.existing([id])).has(id)) {
        settled.push({ key: item.key, outcome: "replayed", id, error: null });
        continue;
      }
      const refusal = refusalOf(error);
      if (!refusal) throw error;
      settled.push({ key: item.key, outcome: "failed", id: null, error: refusal });
    }
  }

  const resolvedIds = settled.flatMap((entry) => (entry.id ? [entry.id] : []));
  const refs = resolvedIds.length > 0 ? await spec.readRefs(resolvedIds) : new Map<string, BatchRef>();
  const result = settled.map((entry) => {
    const ref = entry.id ? refs.get(entry.id) ?? null : null;
    if (entry.id && !ref) {
      return {
        key: entry.key,
        outcome: "failed" as const,
        [spec.noun]: null,
        error: { code: "not_found", message: "Created earlier under this key, but it is in the trash. Delete it permanently or use a new key to create it again." },
      };
    }
    return { key: entry.key, outcome: entry.outcome, [spec.noun]: ref, error: entry.error };
  });
  return { data: { items: result }, createdIds };
}
