// Runs the demo import and removal in bounded slices. A slice spends at most
// `budget` platform calls (Free allows 50 per run and 60 API calls a
// minute), so a whole import takes several slices: the admin button runs
// one and the every-minute cron runs the rest. Each create carries a retry
// key made of the job id and the step, so a slice that failed after a
// create replays it instead of creating it twice; what a step created is
// recorded in `demo_items`, and removal trashes only those, at the revision
// they were created with (an item the merchant changed since is kept).

import type { PluginContext, PluginObjectCollection, PluginRecordVersion } from "@scalius/plugin-sdk";
import type { DemoPack } from "../../demo-pack";
import { byDepth, description, importPlan, mediaStepId, optionMatrix, removalOrder, type DemoRecord, type Step } from "./plan";

export interface DemoJob {
  mode: "import" | "remove" | "idle";
  /** Part of every retry key: a new import never replays an earlier one's answers. */
  id: string;
  done: number;
  total: number;
  /** Items removal kept because they changed since the import. */
  kept: number;
  error: string | null;
  updated_at: string;
}

export const JOB_KEY = "demo_job";
const IDLE: DemoJob = { mode: "idle", id: "", done: 0, total: 0, kept: 0, error: null, updated_at: "" };
/** Calls one slice may spend, below Free's 50 per run, leaving room for the slice's own reads and writes. */
export const SLICE_BUDGET = 36;

type Records = Map<string, PluginRecordVersion<DemoRecord> & { id: string }>;

function items(ctx: PluginContext): PluginObjectCollection<DemoRecord> {
  const collection = ctx.objects.demo_items;
  if (!collection) throw new Error("The demo_items object is not declared.");
  return collection as unknown as PluginObjectCollection<DemoRecord>;
}

export async function readJob(ctx: PluginContext): Promise<DemoJob> {
  return { ...IDLE, ...((await ctx.kv.get<DemoJob>(JOB_KEY)) ?? {}) };
}

async function saveJob(ctx: PluginContext, job: DemoJob): Promise<void> {
  await ctx.kv.set(JOB_KEY, { ...job, updated_at: new Date().toISOString() });
}

/** Every record the demo created (two pages of 100 cover the pack). */
export async function readRecords(ctx: PluginContext): Promise<Records> {
  const records: Records = new Map();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await items(ctx).query({ limit: 100, cursor });
    for (const record of result.records) records.set(record.id, record);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return records;
}

export function startImport(job: DemoJob, total: number, now = Date.now()): DemoJob {
  return { ...IDLE, mode: "import", id: now.toString(36), total, done: job.mode === "import" ? job.done : 0 };
}

class SliceError extends Error {
  constructor(message: string, readonly stop: boolean) {
    super(message);
  }
}

/** One step's call; returns the record to keep. */
async function runStep(ctx: PluginContext, pack: DemoPack, step: Step, records: Records, made: Map<string, DemoRecord>, jobId: string): Promise<DemoRecord> {
  const idempotencyKey = `volt-${jobId}-${step.id}`.slice(0, 200);
  const created = (id: string) => made.get(id) ?? records.get(id)?.data ?? null;
  const call = async <T>(operation: string, input: Parameters<PluginContext["api"]["call"]>[1]) => {
    const result = await ctx.api.call<T>(operation, { ...input, idempotencyKey });
    if (result.ok) return result.data as T;
    const rateLimited = result.status === 429 || result.error?.code === "rate_limited";
    throw new SliceError(rateLimited ? "rate_limited" : `${step.id}: ${result.error?.message ?? `HTTP ${result.status}`}`.slice(0, 300), true);
  };
  const base = { kind: step.kind, key: step.key, url: null, filename: null, size: null, created_at: null, depth: 0 } satisfies Omit<DemoRecord, "resource_id" | "revision">;

  if (step.kind === "media") {
    const data = await call<{ data: { file: { id: string; url: string; filename: string; size: number; createdAt: string | number; version: number } } }>(
      "dashboard.media.import_url", { body: { sourceUrl: step.url } },
    );
    const file = data.data.file;
    return { ...base, resource_id: file.id, revision: file.version, url: file.url, filename: file.filename, size: file.size, created_at: String(file.createdAt) };
  }
  if (step.kind === "category") {
    const category = byDepth(pack).find((entry) => entry.key === step.key)!;
    const image = category.image ? created(mediaStepId(`category-${category.key}`)) : null;
    const parent = category.parent ? created(`category:${category.parent}`) : null;
    if (category.parent && !parent) throw new SliceError(`${step.id}: its parent was not created`, true);
    const data = await call<{ data: { id: string; revision: number } }>("dashboard.categories.create", {
      body: {
        name: category.name, slug: category.key.length >= 3 ? category.key : undefined, description: null, metaTitle: null, metaDescription: null,
        image: image ? { id: image.resource_id, url: image.url, filename: image.filename, size: image.size ?? 0, createdAt: image.created_at } : null,
        parentId: parent?.resource_id ?? null, status: "published", noIndex: true, excludeFromSitemap: true,
      },
    });
    return { ...base, resource_id: data.data.id, revision: data.data.revision, depth: category.depth };
  }
  if (step.kind === "brand") {
    const brand = pack.brands.find((entry) => entry.key === step.key)!;
    const data = await call<{ data: { id: string; revision: number } }>("dashboard.brands.create", {
      body: { name: brand.name, slug: brand.key, status: "published", noIndex: true, excludeFromSitemap: true },
    });
    return { ...base, resource_id: data.data.id, revision: data.data.revision };
  }
  if (step.kind === "product") {
    const product = pack.products.find((entry) => entry.key === step.key)!;
    const category = created(`category:${product.category}`);
    if (!category) throw new SliceError(`${step.id}: its category was not created`, true);
    const brand = product.brand ? created(`brand:${product.brand}`) : null;
    const media = product.images.flatMap((_, index) => {
      const file = created(mediaStepId(`product-${product.key}`, index));
      return file ? [{ id: `draft_media_${index}`, mediaId: file.resource_id, altText: product.name, isPrimary: index === 0 }] : [];
    });
    const discount = product.was && product.was > product.price ? product.was - product.price : 0;
    const stock = product.stock ?? 25;
    const data = await call<{ data: { id: string; aggregateRevision: number } }>("dashboard.products.create", {
      body: {
        name: product.name, slug: product.key, description: description(product), price: product.was ?? product.price,
        categoryId: category.resource_id, ...(brand ? { brandId: brand.resource_id } : {}),
        isActive: true, freeDelivery: false, metaTitle: null, metaDescription: null, productCondition: "new",
        noIndex: true, excludeFromSitemap: true,
        discountType: "flat", discountPercentage: 0, discountAmount: discount,
        media,
        ...(product.options?.length ? { optionMatrix: optionMatrix(product, Math.max(1, Math.round(stock / 3))) } : { defaultSku: { trackInventory: true, stock } }),
      },
    });
    return { ...base, resource_id: data.data.id, revision: data.data.aggregateRevision };
  }
  if (step.kind === "fields") {
    const product = pack.products.find((entry) => entry.key === step.key)!;
    const owner = created(`product:${product.key}`);
    if (!owner) throw new SliceError(`${step.id}: its product was not created`, true);
    await ctx.customFields.set("product", owner.resource_id, {
      ...(product.specs ? { specs: product.specs } : {}),
      ...(product.features ? { key_features: product.features } : {}),
      ...(product.code ? { product_code: product.code } : {}),
    });
    return { ...base, resource_id: owner.resource_id, revision: 0 };
  }
  const collection = pack.collections.find((entry) => entry.key === step.key)!;
  const productIds = collection.products.flatMap((key) => {
    const record = created(`product:${key}`);
    return record ? [record.resource_id] : [];
  });
  const data = await call<{ data: { id: string; version: number } }>("dashboard.collections.create", {
    body: {
      name: collection.name, presentation: "grid", isActive: true, noIndex: true, excludeFromSitemap: true,
      config: { source: "manual", productIds, categoryIds: [], maxProducts: Math.min(24, Math.max(1, productIds.length)), title: collection.name },
    },
  });
  return { ...base, resource_id: data.data.id, revision: data.data.version };
}

/** Writes the slice's new records, 25 to a batch. */
async function writeRecords(ctx: PluginContext, made: Map<string, DemoRecord>): Promise<void> {
  const entries = [...made.entries()];
  for (let index = 0; index < entries.length; index += 25) {
    await ctx.objects.batch(entries.slice(index, index + 25).map(([id, record]) => ({ op: "put" as const, object: "demo_items", id, record: { ...record } })));
  }
}

export interface SliceResult {
  job: DemoJob;
  ran: number;
}

/** One import slice: the next steps that have no record yet, within the budget. */
export async function importSlice(ctx: PluginContext, pack: DemoPack, budget = SLICE_BUDGET): Promise<SliceResult> {
  const plan = importPlan(pack);
  let job = await readJob(ctx);
  if (job.mode !== "import") job = startImport(job, plan.length);
  const records = await readRecords(ctx);
  const made = new Map<string, DemoRecord>();
  const writes = Math.ceil(budget / 25) + 1;
  let spent = 3 + writes;
  let error: string | null = null;
  for (const step of plan) {
    if (records.has(step.id) || made.has(step.id)) continue;
    if (spent >= budget) break;
    try {
      made.set(step.id, await runStep(ctx, pack, step, records, made, job.id));
      spent += 1;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      error = message === "rate_limited" ? null : message;
      break;
    }
  }
  await writeRecords(ctx, made);
  const done = plan.filter((step) => records.has(step.id) || made.has(step.id)).length;
  job = { ...job, done, total: plan.length, error, mode: done >= plan.length ? "idle" : "import" };
  await saveJob(ctx, job);
  if (error) ctx.log.warn("Demo import stopped", { step: error.slice(0, 120) });
  return { job, ran: made.size };
}

/** One removal slice: trash what the demo created, newest dependants first, at the revision it was created with. */
export async function removeSlice(ctx: PluginContext, pack: DemoPack, budget = SLICE_BUDGET): Promise<SliceResult> {
  let job = await readJob(ctx);
  const records = await readRecords(ctx);
  if (job.mode !== "remove") job = { ...IDLE, mode: "remove", id: Date.now().toString(36), total: records.size };
  const ordered = removalOrder([...records.values()].map((record) => ({ id: record.id, data: record.data })));
  const gone: string[] = [];
  let kept = job.kept;
  let spent = 3 + Math.ceil(budget / 25) + 1;
  let error: string | null = null;

  // What a kept product shows stays with it: its photos, fields, brand and category chain are forgotten, not trashed.
  const forgotten = new Set<string>();
  const keepWith = (productKey: string) => {
    const product = pack.products.find((entry) => entry.key === productKey);
    if (!product) return;
    const parents = new Map(pack.categories.map((category) => [category.key, category.parent]));
    const ids = [`fields:${product.key}`, ...product.images.map((_, index) => mediaStepId(`product-${product.key}`, index))];
    if (product.brand) ids.push(`brand:${product.brand}`);
    for (let category: string | undefined = product.category, depth = 0; category && depth < 5; category = parents.get(category), depth += 1) {
      ids.push(`category:${category}`, mediaStepId(`category-${category}`));
    }
    for (const id of ids) if (records.has(id)) { forgotten.add(id); gone.push(id); }
  };
  // Brands go in one call (the operation takes up to 90).
  const brandsOf = () => ordered.filter((entry) => entry.data.kind === "brand" && !forgotten.has(entry.id));
  let brands = brandsOf();
  for (const entry of ordered) {
    if (spent >= budget) break;
    if (forgotten.has(entry.id)) continue;
    const { kind, resource_id: id, revision } = entry.data;
    const idempotencyKey = `volt-rm-${job.id}-${entry.id}`.slice(0, 200);
    let result: { ok: boolean; status: number; error: { code: string; message: string } | null } | null = null;
    if (kind === "fields") {
      gone.push(entry.id); // the product's own fields go with the product
      continue;
    }
    if (kind === "brand") {
      brands = brandsOf();
      if (entry !== brands[0]) continue;
      result = await ctx.api.call("dashboard.brands.trash", { body: { brands: brands.slice(0, 90).map((brand) => ({ id: brand.data.resource_id, expectedRevision: brand.data.revision })) }, idempotencyKey });
      spent += 1;
      if (result.ok) gone.push(...brands.slice(0, 90).map((brand) => brand.id));
    } else {
      const call = {
        collection: () => ctx.api.call("dashboard.collections.trash", { path: { id }, query: { expectedVersion: revision }, idempotencyKey }),
        product: () => ctx.api.call("dashboard.products.trash", { path: { id }, query: { expectedAggregateRevision: revision }, idempotencyKey }),
        category: () => ctx.api.call("dashboard.categories.trash", { path: { id }, body: { expectedRevision: revision }, idempotencyKey }),
        media: () => ctx.api.call("dashboard.media.trash", { path: { id }, body: { expectedVersion: revision }, idempotencyKey }),
      }[kind];
      result = await call();
      spent += 1;
      if (result.ok || result.status === 404) gone.push(entry.id);
    }
    if (result && !result.ok && result.status !== 404) {
      if (result.status === 429 || result.error?.code === "rate_limited") break;
      if (result.status === 409) {
        // Changed since the import (or already in use): the merchant's now; keep it and forget it.
        kept += kind === "brand" ? brands.length : 1;
        gone.push(...(kind === "brand" ? brands.map((brand) => brand.id) : [entry.id]));
        if (kind === "product") keepWith(entry.data.key);
        continue;
      }
      error = `${entry.id}: ${result.error?.message ?? `HTTP ${result.status}`}`.slice(0, 300);
      break;
    }
  }
  for (let index = 0; index < gone.length; index += 25) {
    await ctx.objects.batch(gone.slice(index, index + 25).map((id) => ({ op: "delete" as const, object: "demo_items", id })));
  }
  const left = records.size - new Set(gone).size;
  job = { ...job, done: job.total - left, kept, error, mode: left <= 0 ? "idle" : "remove" };
  await saveJob(ctx, job);
  return { job, ran: gone.length };
}
