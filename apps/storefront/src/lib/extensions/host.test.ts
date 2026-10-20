import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorefrontExtension, StorefrontRenderBatch, StorefrontRenderReply } from "@scalius/shared/plugins/storefront-components";
import { ExtensionHost, clearExtensionMemo, type ExtensionHostOptions } from "./host";
import { orderFormEmbed } from "./embeds";
import type { StorefrontHeaderData } from "@scalius/shared/plugins/storefront-protocol";

const extension: StorefrontExtension = {
  pluginId: "acme.theme", version: "1.0.0", source: "bundled", release: "e".repeat(64),
  sections: ["hero"], sectionSettings: {}, skins: [], components: [], islands: [], stylesheet: false, connect: [],
};

function host(run: (batch: StorefrontRenderBatch) => Promise<StorefrontRenderReply> | StorefrontRenderReply, wallMs?: number, extra: Partial<ExtensionHostOptions> = {}) {
  const calls: StorefrontRenderBatch[] = [];
  const instance = new ExtensionHost({
    runtime: { env: {} },
    context: {
      store: { name: "Acme", currency: "BDT", locale: "en-BD", language: "en", timeZone: "Asia/Dhaka" },
      page: { kind: "home", path: "/" },
      assets: "",
      preview: false,
    },
    run: async (_runtime, _extension, batch) => {
      calls.push(batch);
      return run(batch);
    },
    ...(wallMs ? { wallMs } : {}),
    ...extra,
  });
  return { instance, calls };
}

const echo = (batch: StorefrontRenderBatch): StorefrontRenderReply => ({
  abi: 1,
  results: batch.jobs.map((job) => ({ id: job.id, html: `<p data-n="${job.kind === "section" ? job.instanceId : "slot"}">ok</p>` })),
});

const section = (instanceId: string) => ({ kind: "section" as const, type: "hero", instanceId, settings: {} });

afterEach(() => {
  clearExtensionMemo();
  vi.restoreAllMocks();
});

describe("ExtensionHost", () => {
  it("joins every component asked for in one task into one call per app", async () => {
    const { instance, calls } = host(echo);
    const htmls = await Promise.all(Array.from({ length: 36 }, (_, index) => instance.render(extension, section(`s${index}`))));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.jobs).toHaveLength(36);
    expect(calls[0]!.context.assets).toBe(`/_x/acme.theme/${"e".repeat(64)}/`);
    expect(htmls[7]).toBe('<p data-n="s7">ok</p>');
  });

  it("remembers what it drew: the same input draws without calling the app", async () => {
    const first = host(echo);
    await first.instance.render(extension, section("a"));
    const second = host(echo);
    expect(await second.instance.render(extension, section("a"))).toBe('<p data-n="a">ok</p>');
    expect(second.calls).toHaveLength(0);
    // Another release, another input.
    await second.instance.render({ ...extension, release: "f".repeat(64) }, section("a"));
    expect(second.calls).toHaveLength(1);
  });

  it("checks what an app draws before the page gets it", async () => {
    const { instance } = host((batch) => ({ abi: 1, results: batch.jobs.map((job) => ({ id: job.id, html: `<p onclick="x()">a</p><script>steal()</script>` })) }));
    expect(await instance.render(extension, section("a"))).toBe("<p>a</p>");
  });

  it("varies only the header memo when its lead settings change", async () => {
    const data: StorefrontHeaderData = {
      store: { name: "Acme", url: "/", logo: null, logoWidth: 100 }, menu: [], categories: [], announcement: null,
      routes: { home: "/", search: "/search", cart: "/cart", account: "/account" }, searchParam: "q",
    };
    const header = (layout: string) => ({ kind: "skin" as const, target: "header" as const, component: "head", settings: {}, data: {
      ...data, page: { lead: { kind: "app" as const, pluginId: extension.pluginId, type: "hero", instanceId: "lead", settings: { layout } } },
    } });
    const first = host(echo);
    await Promise.all([first.instance.render(extension, header("overlay")), first.instance.render(extension, section("card"))]);
    const unchanged = host(echo);
    await unchanged.instance.render(extension, header("overlay"));
    expect(unchanged.calls).toHaveLength(0);
    const changed = host(echo);
    await Promise.all([changed.instance.render(extension, header("split")), changed.instance.render(extension, section("card"))]);
    expect(changed.calls).toHaveLength(1);
    expect(changed.calls[0]!.jobs).toHaveLength(1);
    expect(changed.calls[0]!.jobs[0]).toMatchObject({ kind: "skin", target: "header", data: { page: { lead: { settings: { layout: "split" } } } } });
    expect(changed.calls[0]!.context.page).toEqual({ kind: "home", path: "/" });
  });

  it("draws nothing for a failed job, and the rest of the batch still draws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { instance } = host((batch) => ({
      abi: 1,
      results: batch.jobs.map((job, index) => (index === 0 ? { id: job.id, error: "Error: boom" } : { id: job.id, html: "<p>ok</p>" })),
    }));
    const [failed, drawn] = await Promise.all([instance.render(extension, section("a")), instance.render(extension, section("b"))]);
    expect(failed).toBeNull();
    expect(drawn).toBe("<p>ok</p>");
  });

  it("gives up on a slow app within its wall time, and on a thrown one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const slow = host(() => new Promise(() => {}), 20);
    const started = Date.now();
    expect(await slow.instance.render(extension, section("a"))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    const broken = host(() => { throw new Error("isolate gone"); });
    expect(await broken.instance.render(extension, section("b"))).toBeNull();
  });

  it("refuses markup over the size budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { instance } = host((batch) => ({ abi: 1, results: batch.jobs.map((job) => ({ id: job.id, html: "x".repeat(300 * 1024) })) }));
    expect(await instance.render(extension, section("a"))).toBeNull();
  });

  it("keeps every page drawn with a fallback out of the page cache, and only those", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: Array<[string, Parameters<typeof host>[0], number | undefined]> = [
      ["late", () => new Promise(() => {}), 20],
      ["thrown (a release the isolate cannot load)", () => { throw new Error("ExtensionUnavailableError"); }, undefined],
      ["failed job", (batch) => ({ abi: 1, results: batch.jobs.map((job) => ({ id: job.id, error: "Error: boom" })) }), undefined],
      ["no result", () => ({ abi: 1, results: [] }), undefined],
      ["over its bounds", (batch) => ({ abi: 1, results: batch.jobs.map((job) => ({ id: job.id, html: "x".repeat(300 * 1024) })) }), undefined],
    ];
    for (const [name, run, wallMs] of cases) {
      const degraded = vi.fn();
      const { instance } = host(run, wallMs, { degraded });
      expect(await instance.render(extension, section(name)), name).toBeNull();
      expect(degraded, name).toHaveBeenCalled();
    }
    const degraded = vi.fn();
    const drawn = host(echo, undefined, { degraded });
    expect(await drawn.instance.render(extension, section("ok"))).toBe('<p data-n="ok">ok</p>');
    expect(degraded).not.toHaveBeenCalled();
  });

  it("leaves component JSON-LD out of a noindex page, without sharing the memo with an indexed one", async () => {
    const jsonLd = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage"}</script>';
    const run = (batch: StorefrontRenderBatch): StorefrontRenderReply => ({ abi: 1, results: batch.jobs.map((job) => ({ id: job.id, html: `<p>q</p>${jsonLd}` })) });
    expect(await host(run, undefined, { jsonLd: () => true }).instance.render(extension, section("faq"))).toBe(`<p>q</p>${jsonLd}`);
    expect(await host(run, undefined, { jsonLd: () => false }).instance.render(extension, section("faq"))).toBe("<p>q</p>");
  });
});

describe("the order form embed", () => {
  const OrderForm = () => null;
  const render = orderFormEmbed(OrderForm, new Map([["linen-shirt", "linen"]]), { instanceId: "landing order", preview: false });

  it("orders only a product the section was given, with its cap and words", () => {
    expect(render({ data: { product: "linen-shirt", "max-quantity": "30", "submit-label": " Order & pay " }, index: 1 })).toEqual({
      component: OrderForm,
      props: { slug: "linen", idPrefix: "order-landing%20order-1", maxQuantity: 10, submitLabel: "Order & pay", preview: false },
    });
    expect(render({ data: { product: "linen-shirt", "max-quantity": "zero" }, index: 0 })?.props.maxQuantity).toBe(5);
    expect(render({ data: { product: "other" }, index: 0 })).toBeNull();
    expect(render({ data: {}, index: 0 })).toBeNull();
  });
});

describe("skin JSON-LD", () => {
  it("strips app JSON-LD where core owns the page's structured data", async () => {
    const jsonLd = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>';
    const run = (batch: StorefrontRenderBatch): StorefrontRenderReply => ({ abi: 1, results: batch.jobs.map((job) => ({ id: job.id, html: `<p>p</p>${jsonLd}` })) });
    const { instance } = host(run, undefined, { jsonLd: () => true });
    expect(await instance.render(extension, section("a"))).toBe(`<p>p</p>${jsonLd}`);
    expect(await instance.render(extension, section("b"), { jsonLd: false })).toBe("<p>p</p>");
  });
});
