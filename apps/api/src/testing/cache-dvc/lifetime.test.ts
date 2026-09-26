import "@hono/zod-openapi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decideCacheFrontierHit, mergeCacheFrontier } from "@scalius/shared/cache-frontier";
import { DvcHarness } from "./harness";
import { s4Adapters } from "./harness-adapters";
import { DVC_API_VERSION } from "./validators";

const DAY = 86_400_000;
const page = { name: "lifetime-home", parts: ["/api/v1/storefront/homepage"] };
const scheduledPage = { name: "scheduled-pages", parts: ["/api/v1/pages"] };
let run: DvcHarness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const adapters = s4Adapters();
  run = await DvcHarness.create({
    seed: "proof-lifetime",
    parts: [...page.parts, ...scheduledPage.parts],
    pages: [page, scheduledPage],
    setSystemTime: (ms) => vi.setSystemTime(ms),
    recorder: adapters.recorder({ coarse: new Map(), unobserved: new Map() }),
    partValidator: (clock) => adapters.partValidator(clock),
    frontierModel: adapters.frontierModel,
  });
});

afterEach(() => {
  run?.close();
  vi.useRealTimers();
});

it("serves unchanged part/page proofs at 30 and 365 days; eviction only causes a refill", async () => {
  // All seed promotions have reached their last transition by day 20.
  await run.advanceTo(run.now + 20 * DAY);
  await run.warm();
  expect(await run.readPage(page)).toBe("render");
  const original = run.pageCache.get(page.name)!;
  expect(original.meta.apiVersion).toBe(DVC_API_VERSION);
  expect(original.meta.validUntil).toBeNull();
  expect(original.meta.softMaxAgeSeconds).toBeNull();
  for (const days of [30, 365]) {
    await run.advanceTo(original.meta.renderedAt + days * DAY);
    expect(await run.readPage(page)).toBe("serve");
    expect(run.pageCache.get(page.name)).toBe(original);
    expect(run.partCache.get(page.parts[0]!)!.meta.renderedAt).toBe(original.meta.renderedAt);
  }
  run.partCache.clear();
  run.pageCache.clear();
  expect(await run.readPage(page)).toBe("render");
  expect(run.pageCache.get(page.name)!.body).toBe(original.body);
  expect(run.pageCache.get(page.name)!.meta.renderedAt).toBe(run.now);
});

it("refreshes at the actual scheduled deadline without a committed row change", async () => {
  const deadline = run.now + DAY;
  run.sqlite.prepare("UPDATE pages SET published_at = ? WHERE id = 'page_about'").run(deadline / 1000);
  await run.warm();
  await run.readPage(scheduledPage);
  const original = run.pageCache.get(scheduledPage.name)!;
  expect(original.meta.validUntil).toBe(deadline);
  expect(original.body).not.toContain("About us");
  const clock = await run.clock.current();
  await run.advanceTo(deadline - 1);
  expect(await run.readPage(scheduledPage)).toBe("serve");
  await run.advanceTo(deadline);
  expect(await run.clock.current()).toBe(clock);
  expect(await run.readPage(scheduledPage)).toBe("render");
  expect(run.stats.invalidationReasons.expired).toBeGreaterThan(0);
  expect(run.pageCache.get(scheduledPage.name)!.meta.renderedAt).toBe(deadline);
  expect(run.pageCache.get(scheduledPage.name)!.body).toContain("About us");
});

it("rejects an API deployment change and never merges the old deployment's frontier", async () => {
  await run.warm();
  await run.readPage(page);
  const entry = run.pageCache.get(page.name)!.meta;
  const old = mergeCacheFrontier(null, {
    apiVersion: DVC_API_VERSION, S: entry.s0, horizon: 0, floor: 0, changes: [["old-deployment", entry.s0]],
  }, run.now);
  const fresh = mergeCacheFrontier(old, {
    apiVersion: "api-next", S: entry.s0, horizon: 0, floor: 0, changes: [],
  }, run.now);
  expect(fresh.changes.size).toBe(0);
  expect(decideCacheFrontierHit({ ...entry, validUntil: null, softMaxAgeSeconds: null }, fresh, run.now)).toBe("render");
});

it("invalidates a sold-count projection change immediately, without a soft-age grace period", async () => {
  await run.warm();
  const original = run.partCache.get(page.parts[0]!)!;
  expect(original.meta.softMaxAgeSeconds).toBeNull();
  run.sqlite.exec(`INSERT INTO product_sales_stats (product_id, sold_30d) VALUES ('p_linen', 1000)
    ON CONFLICT (product_id) DO UPDATE SET sold_30d = excluded.sold_30d`);
  expect(await run.checkPart(page.parts[0]!)).toEqual({ cached: true, valid: false, equal: false });
  expect(run.now).toBe(original.meta.renderedAt);
});
