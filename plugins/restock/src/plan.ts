// What to reorder, worked out by a background job a few calls at a time.
//
// The plan reads every rule (up to 1,000: 10 record reads), every open
// purchase order (up to 500 in each of three statuses, 50 a call: 30 API
// calls) and the stock of every rule's SKU (90 SKUs a call: 12 or more API
// calls). That is more than the 50 platform calls one run may make on the Free
// plan and most of the app's 60 API calls a minute, so no page view reads it.
// The `check` and `draft` jobs do, in steps of at most STEP_CALLS platform
// calls each. A step stops before a call it cannot afford, or at the first
// rate-limited answer, and keeps what it has read; the job's next step (a
// minute later) continues from there.
//
// What a check finds is stored (`PLAN_KEY` and its chunks) with when it ran,
// and the page shows it with that time. A draft checks, stores what it found,
// and only in a later step creates the purchase orders from what it stored:
// a step that repeats after a crash creates the same orders under the same
// keys, so it replays them instead of ordering twice. It then checks again,
// so the plan it leaves counts what it drafted.
import type { PluginApiCallInput, PluginContext, PluginJobStepInput, PluginJobStepResult } from "@scalius/plugin-sdk";

export interface Rule extends Record<string, unknown> {
  sku: string;
  title: string;
  min_on_hand: number;
  reorder_to: number;
  unit_cost_minor: number;
  supplier_id: string | null;
}

export interface Level { variantId: string; onHand: number }
export interface PurchaseOrder {
  id: string;
  number: number;
  status: string;
  supplierId: string | null;
  currency: string;
  revision: number;
  lines: Array<{ id: string; variantId: string; quantity: number; receivedQuantity: number; unitCostMinor: number }>;
}

/** Platform calls one job step makes at most: inside a Free run's 50, and under the app's 60 API calls a minute. */
export const STEP_CALLS = 44;
/** The most SKUs one `inventory_levels.list` call takes, and the most levels it answers. */
const LEVEL_BATCH = 90;
const LEVEL_PAGE = 250;
/** The most purchase orders one `purchase_orders.list` call answers. */
const ORDER_PAGE = 50;
/** The most records one query answers. */
const RULE_PAGE = 100;
/** The most lines one purchase order takes (`purchase_orders.create`). */
export const MAX_ORDER_LINES = 100;
/** The rules the app reads. */
export const MAX_RULES = 1_000;
/** The record reads that reach every rule. */
const RULE_READS = Math.ceil(MAX_RULES / RULE_PAGE);
/** Open purchase orders read per status: what they still bring in is subtracted from every shortfall. */
export const MAX_OPEN_PER_STATUS = 500;
export const OPEN_STATUSES = ["draft", "ordered", "partially_received"] as const;
/** Lines one stored chunk of the plan holds: two pages of the Reorder now table. */
export const PLAN_CHUNK = 100;
/** The last plan a check stored. */
export const PLAN_KEY = "plan";
export const planChunkKey = (index: number) => `plan:${index}`;
/** The check or draft job that runs now or ran last: one at a time. */
export const PLAN_JOB_KEY = "plan-job";
export const PLAN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type PlanJobName = "check" | "draft";
export interface PlanJobLock { jobId: string; name: PlanJobName }

/** A read the platform refused for the app's API rate (60 calls a minute). */
export class RateLimited extends Error {
  constructor(operation: string) {
    super(`${operation} is rate limited`);
    this.name = "RateLimited";
  }
}

/** One run's platform calls, counted before each is made. */
class Calls {
  used = 0;
  fits(count = 1) {
    return this.used + count <= STEP_CALLS;
  }
  take() {
    this.used += 1;
  }
}

/** A stable API read: its data, `RateLimited` on a 429, an error otherwise. */
export async function apiRead<T>(ctx: Pick<PluginContext, "api">, operation: string, input: PluginApiCallInput): Promise<T> {
  const answer = await ctx.api.call<T>(operation, input);
  if (answer.status === 429) throw new RateLimited(operation);
  if (!answer.ok || !answer.data) throw new Error(`${operation} failed: ${answer.error?.code ?? answer.status}`);
  return answer.data;
}

export interface RuleRecord { id: string; revision: number; data: Rule }

/** Every rule (up to 1,000; 100 a read), by SKU. */
export async function allRules(ctx: Pick<PluginContext, "objects">, calls?: Calls): Promise<RuleRecord[]> {
  const rules: RuleRecord[] = [];
  let cursor: string | null = null;
  do {
    calls?.take();
    const page: { records: Array<{ id: string; revision: number; data: Record<string, unknown> }>; nextCursor: string | null } = await ctx.objects.rules!.query({ limit: RULE_PAGE, ...(cursor ? { cursor } : {}) });
    for (const record of page.records) rules.push({ id: record.id, revision: record.revision, data: record.data as Rule });
    cursor = page.nextCursor;
  } while (cursor && rules.length < MAX_RULES);
  // By SKU, so pages, lines and purchase orders keep one order.
  return rules.sort((left, right) => left.data.sku.localeCompare(right.data.sku, "en", { sensitivity: "base" }) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** An Idempotency-Key: the same parts are the same key (SHA-256, hex; 8 to 200 characters). */
export async function requestKey(prefix: string, parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return `${prefix}-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Which rules, at which revisions: a plan stored with another version predates a rule change. */
export const rulesVersion = (rules: readonly RuleRecord[]) => requestKey("rules", rules.map((rule) => `${rule.id}:${rule.revision}`));

/** Units still to arrive per SKU: what open purchase orders ordered and have not received. */
export function unitsOnOrder(orders: readonly PurchaseOrder[]): Map<string, number> {
  const onOrder = new Map<string, number>();
  for (const order of orders) {
    for (const line of order.lines) {
      const open = line.quantity - line.receivedQuantity;
      if (open > 0) onOrder.set(line.variantId, (onOrder.get(line.variantId) ?? 0) + open);
    }
  }
  return onOrder;
}

/** A SKU to reorder: what it has, what is on order and what to order, with its rule's supplier and cost. */
export interface ShortLine {
  variantId: string;
  sku: string;
  supplierId: string | null;
  unitCostMinor: number;
  onHand: number;
  onOrder: number;
  quantity: number;
}

/**
 * What to order for each rule whose stock position (on hand plus still on
 * order) is at or below its reorder point: up to its target. Units already
 * on an open purchase order count, so drafting again orders nothing twice.
 */
export function shortfall(rules: ReadonlyArray<{ id: string; data: Rule }>, onHand: ReadonlyMap<string, number>, onOrder: ReadonlyMap<string, number> = new Map()): ShortLine[] {
  return rules.flatMap(({ id, data }) => {
    const have = onHand.get(id) ?? 0;
    const incoming = onOrder.get(id) ?? 0;
    const position = have + incoming;
    return position <= data.min_on_hand && data.reorder_to > position
      ? [{ variantId: id, sku: data.sku, supplierId: data.supplier_id, unitCostMinor: data.unit_cost_minor, onHand: have, onOrder: incoming, quantity: data.reorder_to - position }]
      : [];
  });
}

export interface DraftOrder { supplierId: string | null; lines: ShortLine[] }

/** The purchase orders a shortfall drafts: one per supplier, split at 100 lines. */
export function draftOrders(short: readonly ShortLine[]): DraftOrder[] {
  const bySupplier = new Map<string | null, ShortLine[]>();
  for (const line of short) bySupplier.set(line.supplierId, [...(bySupplier.get(line.supplierId) ?? []), line]);
  return [...bySupplier].flatMap(([supplierId, lines]) => {
    const orders: DraftOrder[] = [];
    for (let offset = 0; offset < lines.length; offset += MAX_ORDER_LINES) orders.push({ supplierId, lines: lines.slice(offset, offset + MAX_ORDER_LINES) });
    return orders;
  });
}

/**
 * A draft's key is the draft job and what it creates (its supplier and every
 * line's SKU, quantity and unit cost), never a read such as on hand. A step
 * that repeats creates the same orders from the same stored plan, so it
 * replays them; another draft is another job, so a genuine new draft (after a
 * receipt, a cost edit) is a new key, never a replay or a 422.
 */
export function draftKey(order: DraftOrder, jobId: string): Promise<string> {
  return requestKey("restock-draft", [
    jobId,
    order.supplierId ?? "",
    ...order.lines.map((line) => `${line.variantId}:${line.quantity}:${line.unitCostMinor}`),
  ]);
}

/** What a draft did: drafted of total purchase orders, and the error that stopped it. */
export interface DraftOutcome { drafted: number; total: number; failure: string | null }

/** The plan a check stored: its lines are in `chunks` chunks of PLAN_CHUNK (`planChunkKey`). */
export interface PlanSnapshot {
  jobId: string;
  checkedAt: string;
  rulesVersion: string;
  /** Lines below their reorder point. */
  short: number;
  /** The purchase orders drafting them makes. */
  orders: number;
  chunks: number;
  /** Set when a draft stored it. */
  draft: DraftOutcome | null;
}

/** Every line of a stored plan, in order. */
async function planLines(ctx: Pick<PluginContext, "kv">, plan: PlanSnapshot, calls: Calls): Promise<ShortLine[]> {
  const lines: ShortLine[] = [];
  for (let index = 0; index < plan.chunks; index += 1) {
    calls.take();
    lines.push(...((await ctx.kv.get<ShortLine[]>(planChunkKey(index))) ?? []));
  }
  if (lines.length !== plan.short) throw new Error("The stored plan is incomplete.");
  return lines;
}

/** A check's reads so far, its arrays in the order of the rules it read (`ids`). */
interface Scan {
  ids: string;
  rules: number;
  /** The next status to read (`OPEN_STATUSES`), its cursor and what it has read of it. */
  status: number;
  cursor: string | null;
  read: number;
  onOrder: number[];
  /** The next batch of 90 rules whose stock to read, and its cursor. */
  batch: number;
  levelCursor: string | null;
  onHand: number[];
}

interface PlanState {
  /** `scan` reads; `create` drafts the stored plan's purchase orders (`next` of `total`). */
  phase: "scan" | "create";
  /** 1: the check; 2: a draft's check after creating. */
  pass: 1 | 2;
  scan: Scan | null;
  next: number;
  drafted: number;
  total: number;
  failure: string | null;
}

const initialState = (): PlanState => ({ phase: "scan", pass: 1, scan: null, next: 0, drafted: 0, total: 0, failure: null });

const isPlanState = (value: unknown): value is PlanState => typeof value === "object" && value !== null && ((value as PlanState).phase === "scan" || (value as PlanState).phase === "create");

/** Progress in parts of 100: reading orders, reading stock (and for a draft, creating and checking again). */
function progressOf(state: PlanState, draft: boolean, finished: boolean) {
  const total = draft ? 400 : 200;
  if (finished) return { done: total, total };
  const scanned = (scan: Scan | null) => scan
    ? Math.floor((scan.status / OPEN_STATUSES.length) * 100) + (scan.rules === 0 ? 100 : Math.floor((Math.min(scan.batch * LEVEL_BATCH, scan.rules) / scan.rules) * 100))
    : 0;
  const done = state.phase === "create"
    ? 200 + (state.total > 0 ? Math.floor((state.next / state.total) * 100) : 0)
    : (state.pass === 2 ? 300 : 0) + scanned(state.scan);
  return { done: Math.min(done, total), total };
}

/** One step of a check (`draft` false) or a draft. */
export async function planStep(ctx: PluginContext, job: PluginJobStepInput, draft: boolean): Promise<PluginJobStepResult> {
  const calls = new Calls();
  let state = isPlanState(job.state) ? job.state : initialState();
  const answer = (finished = false): PluginJobStepResult => ({ state, progress: progressOf(state, draft, finished), done: finished });
  try {
    if (state.phase === "create") {
      calls.take();
      const plan = await ctx.kv.get<PlanSnapshot>(PLAN_KEY);
      if (!plan || plan.jobId !== job.id) throw new Error("The plan this draft stored is gone.");
      const orders = draftOrders(await planLines(ctx, plan, calls));
      while (state.next < orders.length && state.failure === null) {
        if (!calls.fits()) return answer();
        const order = orders[state.next]!;
        calls.take();
        const created = await ctx.api.call<{ purchaseOrder: PurchaseOrder }>("purchase_orders.create", {
          body: { supplierId: order.supplierId, lines: order.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitCostMinor: line.unitCostMinor })) },
          idempotencyKey: await draftKey(order, job.id),
        });
        if (created.status === 429) return answer();
        if (!created.ok || !created.data) state = { ...state, failure: created.error?.message ?? "purchase_orders.create failed" };
        else state = { ...state, next: state.next + 1, drafted: state.drafted + 1 };
      }
      if (state.drafted === 0) {
        // Nothing was drafted: the plan as checked stands, with why.
        if (!calls.fits()) return answer();
        calls.take();
        await ctx.kv.set(PLAN_KEY, { ...plan, draft: outcome(state) } satisfies PlanSnapshot, { ttlSeconds: PLAN_TTL_SECONDS });
        return answer(true);
      }
      state = { ...state, phase: "scan", pass: 2, scan: null };
    }

    if (!calls.fits(RULE_READS)) return answer();
    const rules = await allRules(ctx, calls);
    const ids = await requestKey("ids", rules.map((rule) => rule.id));
    // A rule added or removed since the last step: its arrays no longer line up, so read again.
    const scan: Scan = state.scan && state.scan.ids === ids
      ? state.scan
      : { ids, rules: rules.length, status: rules.length === 0 ? OPEN_STATUSES.length : 0, cursor: null, read: 0, onOrder: rules.map(() => 0), batch: 0, levelCursor: null, onHand: rules.map(() => 0) };
    state = { ...state, scan };
    const position = new Map(rules.map((rule, index) => [rule.id, index]));
    const counted = new Set<string>();

    while (scan.status < OPEN_STATUSES.length) {
      if (!calls.fits()) return answer();
      calls.take();
      const page = await apiRead<{ purchaseOrders: PurchaseOrder[]; nextCursor: string | null }>(ctx, "purchase_orders.list", {
        query: { status: OPEN_STATUSES[scan.status], limit: ORDER_PAGE, ...(scan.cursor ? { cursor: scan.cursor } : {}) },
      });
      // A purchase order changed while this step read moves to the end of its list: count it once.
      const fresh = page.purchaseOrders.filter((order) => !counted.has(order.id));
      for (const order of fresh) counted.add(order.id);
      for (const [variantId, units] of unitsOnOrder(fresh)) {
        const index = position.get(variantId);
        if (index !== undefined) scan.onOrder[index]! += units;
      }
      scan.read += page.purchaseOrders.length;
      if (page.nextCursor && scan.read < MAX_OPEN_PER_STATUS) scan.cursor = page.nextCursor;
      else Object.assign(scan, { status: scan.status + 1, cursor: null, read: 0 });
    }

    while (scan.batch * LEVEL_BATCH < rules.length) {
      if (!calls.fits()) return answer();
      calls.take();
      const page = await apiRead<{ levels: Level[]; nextCursor: string | null }>(ctx, "inventory_levels.list", {
        query: { variantIds: rules.slice(scan.batch * LEVEL_BATCH, (scan.batch + 1) * LEVEL_BATCH).map((rule) => rule.id).join(","), limit: LEVEL_PAGE, ...(scan.levelCursor ? { cursor: scan.levelCursor } : {}) },
      });
      for (const level of page.levels) {
        const index = position.get(level.variantId);
        if (index !== undefined) scan.onHand[index]! += level.onHand;
      }
      if (page.nextCursor) scan.levelCursor = page.nextCursor;
      else Object.assign(scan, { batch: scan.batch + 1, levelCursor: null });
    }

    const short = shortfall(rules, new Map(rules.map((rule, index) => [rule.id, scan.onHand[index]!])), new Map(rules.map((rule, index) => [rule.id, scan.onOrder[index]!])));
    const chunks = Math.ceil(short.length / PLAN_CHUNK);
    if (!calls.fits(chunks + 1)) return answer();
    for (let index = 0; index < chunks; index += 1) {
      calls.take();
      await ctx.kv.set(planChunkKey(index), short.slice(index * PLAN_CHUNK, (index + 1) * PLAN_CHUNK), { ttlSeconds: PLAN_TTL_SECONDS });
    }
    const orders = draftOrders(short).length;
    const drafting = draft && state.pass === 1 && orders > 0;
    const plan: PlanSnapshot = {
      jobId: job.id,
      checkedAt: new Date().toISOString(),
      rulesVersion: await rulesVersion(rules),
      short: short.length,
      orders,
      chunks,
      draft: draft && !drafting ? outcome(state) : null,
    };
    calls.take();
    await ctx.kv.set(PLAN_KEY, plan, { ttlSeconds: PLAN_TTL_SECONDS });
    if (!drafting) return answer(true);
    // The orders are created in the next step, from the plan just stored.
    state = { ...state, phase: "create", scan: null, next: 0, total: orders };
    return answer();
  } catch (error) {
    if (error instanceof RateLimited) return answer();
    throw error;
  }
}

const outcome = (state: PlanState): DraftOutcome => ({ drafted: state.drafted, total: state.total, failure: state.failure });

/**
 * Starts a check or a draft unless one is running: `busy` then. Two clicks at
 * once both start a job, and only the one that takes the lock keeps it.
 */
export async function startPlanJob(ctx: PluginContext, name: PlanJobName): Promise<"started" | "busy"> {
  const lock = await ctx.kv.getVersion<PlanJobLock>(PLAN_JOB_KEY);
  if (lock && (await ctx.jobs.get(lock.value.jobId))?.status === "running") return "busy";
  let started: { id: string };
  try {
    started = await ctx.jobs.start(name);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "jobs_limit" || /jobs_limit/.test(error instanceof Error ? error.message : "")) return "busy";
    throw error;
  }
  try {
    await ctx.kv.compareAndSet(PLAN_JOB_KEY, lock?.revision ?? null, { jobId: started.id, name } satisfies PlanJobLock, { ttlSeconds: PLAN_TTL_SECONDS });
  } catch (error) {
    await ctx.jobs.cancel(started.id);
    if ((error as { code?: unknown } | null)?.code === "kv_conflict" || /kv_conflict/.test(error instanceof Error ? error.message : "")) return "busy";
    throw error;
  }
  return "started";
}
