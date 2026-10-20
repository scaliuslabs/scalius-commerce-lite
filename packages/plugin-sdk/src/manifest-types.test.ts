// Manifest type inference (DX-3): definePlugin types ctx.objects records and
// ctx.settings from a defineManifest manifest; a loose manifest keeps the
// loose types; typed contexts stay assignable to PluginContext.
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineManifest, definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput, type PluginMoney, type StorefrontSettingsOf } from "./index";
import { createPluginTestHarness } from "./testing";

const manifest = defineManifest({
  id: "acme.typed",
  name: "Typed",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Types from its manifest.",
  author: { name: "Acme" },
  events: ["order.created"],
  functions: [{ point: "checkout.discounts" }],
  settings: [
    { key: "label", label: "Label", type: "text", default: "Hello" },
    { key: "mode", label: "Mode", type: "select", options: [{ value: "fast", label: "Fast" }, { value: "slow", label: "Slow" }], default: "fast" },
    { key: "limit", label: "Limit", type: "number" },
  ],
  objects: {
    notes: {
      name: "Notes",
      fields: [
        { key: "value", name: "Value", type: "single_line_text", required: true },
        { key: "count", name: "Count", type: "integer" },
        { key: "tags", name: "Tags", type: "list.single_line_text" },
      ],
    },
    prices: {
      name: "Prices",
      fields: [
        { key: "price", name: "Price", type: "money", required: true },
        { key: "tiers", name: "Tiers", type: "list.money" },
      ],
    },
  },
  storefront: {
    sections: [{
      type: "banner",
      name: "Banner",
      settings: [
        { key: "heading", label: "Heading", type: "text", default: "Hi", maxLength: 120 },
        { key: "columns", label: "Columns", type: "number", default: 2, min: 1, max: 4 },
      ],
    }],
  },
});

function helper(ctx: PluginContext) {
  return ctx.plugin.id;
}

describe("manifest type inference", () => {
  it("types records and settings from the manifest", async () => {
    let pricesRead: unknown;
    const plugin = definePlugin({
      manifest,
      events: {
        "order.created": async (event, ctx) => {
          const note = await ctx.objects.notes.get("last");
          expectTypeOf(note).toEqualTypeOf<({ value: string } & { count?: number | null; tags?: string[] | null }) | null>();
          expectTypeOf(ctx.settings.label).toEqualTypeOf<string>();
          expectTypeOf(ctx.settings.mode).toEqualTypeOf<"fast" | "slow">();
          expectTypeOf(ctx.settings.limit).toEqualTypeOf<number | null | undefined>();
          helper(ctx);
          await ctx.objects.notes.put("last", { value: event.resource.id });
          // Money fields read and write `PluginMoney` (integer minor units), as the codec does.
          const price = await ctx.objects.prices.get("standard");
          expectTypeOf(price).toEqualTypeOf<({ price: PluginMoney } & { tiers?: PluginMoney[] | null }) | null>();
          await ctx.objects.prices.put("standard", { price: { amountMinor: 125_000, currency: "BDT" }, tiers: [{ amountMinor: 99_000, currency: "BDT" }] });
          pricesRead = await ctx.objects.prices.get("standard");
          // Type-only: the platform refuses a bare number or a decimal string (object.invalid).
          type PriceWrite = Parameters<typeof ctx.objects.prices.put>[1];
          expectTypeOf<{ price: number }>().not.toExtend<PriceWrite>();
          expectTypeOf<{ price: string }>().not.toExtend<PriceWrite>();
          expectTypeOf<{ price: PluginMoney; tiers: number[] }>().not.toExtend<PriceWrite>();
        },
      },
      functions: {
        "checkout.discounts": (_input, settings) => {
          expectTypeOf(settings.mode).toEqualTypeOf<"fast" | "slow">();
          return { discounts: [] };
        },
      },
    });
    const harness = createPluginTestHarness(plugin);
    expect((await harness.event("order.created", { type: "order", id: "o1" })).ok).toBe(true);
    expect(harness.records.get("notes")?.get("last")).toEqual({ value: "o1" });
    expect(pricesRead).toEqual({
      price: { amountMinor: 125_000, currency: "BDT" },
      tiers: [{ amountMinor: 99_000, currency: "BDT" }],
    });
  });

  it("types storefront component settings", () => {
    type Banner = StorefrontSettingsOf<typeof manifest, "section", "banner">;
    expectTypeOf<Banner["heading"]>().toEqualTypeOf<string>();
    expectTypeOf<Banner["columns"]>().toEqualTypeOf<number>();
  });

  it("keeps a manifest written without defineManifest loose, as before", () => {
    const loose: PluginManifestInput = manifest;
    const satisfied = { id: "acme.loose", name: "Loose", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Loose.", author: { name: "Acme" }, events: ["order.created"], objects: { notes: { name: "Notes", fields: [{ key: "value", name: "Value", type: "single_line_text" }] } } } satisfies PluginManifestInput;
    definePlugin({
      manifest: loose,
      events: {
        "order.created": async (_event, ctx) => {
          expectTypeOf(ctx).toEqualTypeOf<PluginContext>();
          helper(ctx);
        },
      },
    });
    definePlugin({
      manifest: satisfied,
      events: {
        "order.created": async (_event, ctx) => {
          expectTypeOf(ctx).toEqualTypeOf<PluginContext>();
        },
      },
    });
  });
});
