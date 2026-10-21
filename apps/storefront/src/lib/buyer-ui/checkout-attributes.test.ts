import { describe, expect, it } from "vitest";
import { CHECKOUT_ATTRIBUTES_MAX_BYTES as SCHEMA_MAX_BYTES, checkoutAttributesSchema } from "@scalius/shared/plugins/buyer-ui";

import {
  CHECKOUT_ATTRIBUTES_MAX_BYTES,
  CHECKOUT_ATTRIBUTE_KEY_MAX_LENGTH,
  CHECKOUT_ATTRIBUTE_VALUE_MAX_LENGTH,
  parseCheckoutAttributeValues,
} from "./checkout-attributes";

/** What the schema answers, in the guard's shape. */
function viaSchema(value: unknown): Record<string, string> | null {
  const parsed = checkoutAttributesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function expectSameAsSchema(value: unknown): void {
  const expected = viaSchema(value);
  const actual = parseCheckoutAttributeValues(value);
  expect(actual).toEqual(expected);
  if (actual) expect(Object.keys(actual)).toEqual(Object.keys(expected!));
}

/** Deterministic pseudo-random values (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "z", "_", "0", " ", "é", "ক", "😀", "\u0000", "\""];

function text(next: () => number, maxLength: number): string {
  const length = Math.floor(next() * maxLength);
  let out = "";
  for (let index = 0; index < length; index += 1) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

function candidate(next: () => number): unknown {
  const roll = next();
  if (roll < 0.04) return null;
  if (roll < 0.08) return ["a"];
  if (roll < 0.1) return "answers";
  const record: Record<string, unknown> = {};
  const size = Math.floor(next() * 24);
  for (let index = 0; index < size; index += 1) {
    const key = next() < 0.05 ? "x".repeat(CHECKOUT_ATTRIBUTE_KEY_MAX_LENGTH + Math.floor(next() * 2)) : text(next, 12);
    const kind = next();
    record[key] =
      kind < 0.05 ? 7 :
      kind < 0.08 ? null :
      kind < 0.15 ? "v".repeat(CHECKOUT_ATTRIBUTE_VALUE_MAX_LENGTH - 1 + Math.floor(next() * 3)) :
      kind < 0.3 ? "ক".repeat(Math.floor(next() * 500)) :
      text(next, 40);
  }
  return record;
}

describe("checkout attribute guard", () => {
  it("uses the schema's limits", () => {
    expect(CHECKOUT_ATTRIBUTES_MAX_BYTES).toBe(SCHEMA_MAX_BYTES);
    const atKeyLimit = { ["k".repeat(CHECKOUT_ATTRIBUTE_KEY_MAX_LENGTH)]: "v" };
    expect(viaSchema(atKeyLimit)).not.toBeNull();
    expect(viaSchema({ ["k".repeat(CHECKOUT_ATTRIBUTE_KEY_MAX_LENGTH + 1)]: "v" })).toBeNull();
    expect(viaSchema({ k: "v".repeat(CHECKOUT_ATTRIBUTE_VALUE_MAX_LENGTH) })).not.toBeNull();
    expect(viaSchema({ k: "v".repeat(CHECKOUT_ATTRIBUTE_VALUE_MAX_LENGTH + 1) })).toBeNull();
  });

  it.each<[string, unknown]>([
    ["an empty record", {}],
    ["answers", { gift_note: "For Rima", size_check: "yes" }],
    ["a JSON __proto__ key", JSON.parse('{"__proto__":"x","note":"hi"}')],
    ["a spread __proto__ key", { ...{ note: "hi" }, ["__proto__"]: "x" }],
    ["integer-like keys", JSON.parse('{"b":"1","2":"two","1":"one"}')],
    ["a number value", { note: 1 }],
    ["a nested value", { note: { text: "hi" } }],
    ["an array", ["hi"]],
    ["null", null],
    ["a string", "note"],
    ["a class instance", new Date(0)],
    ["a null-prototype record", Object.assign(Object.create(null), { note: "hi" })],
    ["a symbol key", { [Symbol("note")]: "hi" }],
    ["a non-enumerable key", Object.defineProperty({ note: "hi" }, "hidden", { value: 7, enumerable: false })],
    ["about 8 KiB", { k: "v".repeat(500), ...Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`k${index}`, "v".repeat(500)])) }],
    ["more than 8 KiB", Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, "ক".repeat(500)]))],
  ])("answers as the schema does for %s", (_name, value) => {
    expectSameAsSchema(value);
  });

  it("answers as the schema does for generated records", () => {
    const next = random(20261021);
    const outcomes = new Set<boolean>();
    for (let run = 0; run < 2_000; run += 1) {
      const value = candidate(next);
      expectSameAsSchema(value);
      outcomes.add(viaSchema(value) !== null);
    }
    // The corpus reaches both answers.
    expect([...outcomes].sort()).toEqual([false, true]);
  });
});
