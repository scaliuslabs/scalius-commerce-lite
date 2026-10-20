import { describe, expect, it } from "vitest";
import { z } from "zod";
import { manifestBreakingChanges, protocolBreakingChanges, snapshotFingerprint, unacknowledgedBreaks } from "./abi-compat";

const schema = (value: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(value, { io });
const manifest = (value: z.ZodType) => ({ apiVersion: "2026-10", schema: schema(value) });
const port = (input: z.ZodType, output: z.ZodType) => ({ input: schema(input), output: schema(output, "output") });

describe("plugin ABI breaking changes", () => {
  it("lets the manifest accept more, never less", () => {
    const before = manifest(z.object({ id: z.string(), tags: z.array(z.enum(["a", "b"])).optional() }).strict());
    expect(manifestBreakingChanges(before, manifest(z.object({ id: z.string(), tags: z.array(z.enum(["a", "b", "c"])).optional(), icon: z.string().optional() }).strict()))).toEqual([]);
    expect(manifestBreakingChanges(before, manifest(z.object({ id: z.string().max(10), tags: z.array(z.enum(["a"])).optional() }).strict()))).toEqual([
      "manifest id: maxLength tightened to 10.",
      "manifest tags[]: no longer accepts \"b\".",
    ]);
    // A union of primitive types is a type list: the same list, or a wider one, is no change.
    const union = manifest(z.object({ id: z.string(), min: z.union([z.string(), z.number()]).optional() }).strict());
    expect(manifestBreakingChanges(union, union)).toEqual([]);
    expect(manifestBreakingChanges(union, manifest(z.object({ id: z.string(), min: z.union([z.string(), z.number(), z.boolean()]).optional() }).strict()))).toEqual([]);
    expect(manifestBreakingChanges(union, manifest(z.object({ id: z.string(), min: z.string().optional() }).strict())))
      .toEqual(["manifest min: type changed from string,number to string."]);
    expect(manifestBreakingChanges(before, manifest(z.object({ id: z.string(), name: z.string() }).strict()))).toEqual([
      "manifest tags: the field is no longer accepted.",
      "manifest name: a new required field.",
    ]);
  });

  it("reads a port's input as the host's promise and its output as what the host accepts", () => {
    const before = { providers: { sms: { send: port(z.object({ to: z.string(), text: z.string() }), z.object({ success: z.boolean(), ref: z.string().nullable() })) } } };
    const after = { providers: { sms: { send: port(z.object({ to: z.string(), text: z.string().nullable() }), z.object({ success: z.boolean() })) } } };
    expect(protocolBreakingChanges(before, after)).toEqual([
      "providers.sms.send input text: the response may now be null.",
      "providers.sms.send output ref: the field is no longer accepted.",
    ]);
    expect(protocolBreakingChanges(before, { providers: {} })).toEqual(["providers.sms: the stable port was removed."]);
    expect(protocolBreakingChanges(before, { providers: { sms: {} } })).toEqual(["providers.sms.send: the operation was removed."]);
  });

  it("refuses a demoted port, a renamed topic, a lost scope or constant", () => {
    const before = {
      providerTiers: { fraud: "stable" },
      scopes: { read_orders: {} },
      events: { resources: { "gift_card.transaction": "transaction" }, facts: { "gift_card.transaction": schema(z.object({ id: z.string() }), "output") } },
      storefront: { KINDS: ["buy_form", "reviews"], TAG: "x" },
    };
    expect(protocolBreakingChanges(before, {
      providerTiers: { fraud: "beta" },
      scopes: {},
      events: { resources: { "gift_card.transacted": "gift_card_transaction" }, facts: {} },
      storefront: { KINDS: ["reviews"] },
    })).toEqual([
      "providerTiers.fraud: a stable port went back to beta.",
      "scopes.read_orders: the scope was removed.",
      "events.gift_card.transaction: the topic was removed.",
      "storefront.KINDS: \"buy_form\" was removed.",
      "storefront.TAG: the constant was removed.",
    ]);
  });

  it("accepts a break only for the snapshot it breaks from, with a reason", async () => {
    const from = await snapshotFingerprint("committed");
    expect(from).toMatch(/^[0-9a-f]{16}$/);
    const change = "providers.fraud: the stable port was removed.";
    expect(unacknowledgedBreaks("a.json", from, [change], [{ snapshot: "a.json", from, change, reason: "Renamed to courier_history." }])).toEqual([]);
    expect(unacknowledgedBreaks("a.json", from, [change], [{ snapshot: "a.json", from, change, reason: " " }])).toHaveLength(1);
    expect(unacknowledgedBreaks("a.json", from, [change], [{ snapshot: "a.json", from: await snapshotFingerprint("older"), change, reason: "x" }]))
      .toEqual([{ snapshot: "a.json", from, change, reason: "" }]);
  });
});
