// The webhook payload contract (COMMERCE-HOOKS H5): every resource type's
// sealed representation and the truncation shape, under `EVENTS_API_VERSION`.
//
//   1. against the committed snapshot no representation loses a field, makes
//      one optional or nullable, retypes or narrows it (`schema-compat.ts`,
//      the stable app API's response rules), and no protected field loses its
//      marker;
//   2. the snapshot equals the current schemas exactly, so an additive change
//      is reviewed: accept it with `vitest run -u` on this file.
//
// A breaking change needs a new EVENTS_API_VERSION, or (before the lock) an
// entry with a reason in `events.representations.breaks.json`, keyed by the
// committed snapshot's fingerprint the way `abi.breaks.json` is. The sealing
// test refuses first, so `-u` cannot write past an unacknowledged break.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EVENTS_API_VERSION,
  EVENT_REPRESENTATION_SCHEMAS,
  EVENT_RESOURCE_TYPES,
  eventDataTruncationSchema,
  eventRepresentationProtectedPaths,
} from "@scalius/shared/events";
import {
  snapshotFingerprint,
  unacknowledgedBreaks,
  type AbiBreakAcknowledgement,
} from "@scalius/shared/plugins/abi-compat";
import { schemaBreakingChanges } from "@scalius/shared/schema-compat";
import acknowledgements from "../../../../packages/shared/src/events.representations.breaks.json";

const SNAPSHOT_FILE = new URL("../../../../packages/shared/src/events.representations.snapshot.json", import.meta.url);
const SNAPSHOT_NAME = "events.representations.snapshot.json";

interface RepresentationSnapshot {
  apiVersion: string;
  representations: Record<string, unknown>;
  truncation: unknown;
  /** Each type's protected fields (`path` joined with "."). */
  protected: Record<string, string[]>;
}

/** Receivers must tolerate fields added later, so the published schema never closes an object. */
function open<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(open) as T;
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key, value]) => !(key === "additionalProperties" && value === false))
    .map(([key, value]) => [key, open(value)])) as T;
}
const schemaOf = (schema: z.ZodType) => open(z.toJSONSchema(schema, { target: "openapi-3.0", io: "output", unrepresentable: "any" }));

function currentSnapshot(): RepresentationSnapshot {
  return {
    apiVersion: EVENTS_API_VERSION,
    representations: Object.fromEntries(Object.entries(EVENT_REPRESENTATION_SCHEMAS).map(([type, schema]) => [type, schemaOf(schema)])),
    truncation: schemaOf(eventDataTruncationSchema),
    protected: Object.fromEntries(Object.keys(EVENT_REPRESENTATION_SCHEMAS).map((type) => [
      type,
      eventRepresentationProtectedPaths(type as keyof typeof EVENT_REPRESENTATION_SCHEMAS)
        .map(({ path, categories }) => `${path.join(".")}=${categories.join("+")}`).sort(),
    ])),
  };
}

function committedText(): string | null {
  try {
    return readFileSync(SNAPSHOT_FILE, "utf8");
  } catch {
    return null;
  }
}

function committedSnapshot(): RepresentationSnapshot | null {
  const text = committedText();
  return text === null ? null : JSON.parse(text) as RepresentationSnapshot;
}

/** The committed snapshot's breaks that no entry in the breaks file accepts. */
async function openBreaks(): Promise<AbiBreakAcknowledgement[]> {
  const text = committedText();
  if (text === null) return [];
  return unacknowledgedBreaks(SNAPSHOT_NAME, await snapshotFingerprint(text),
    breakingChanges(JSON.parse(text) as RepresentationSnapshot, currentSnapshot()), acknowledgements as AbiBreakAcknowledgement[]);
}

function breakingChanges(before: RepresentationSnapshot, after: RepresentationSnapshot): string[] {
  const problems: string[] = [];
  if (before.apiVersion !== after.apiVersion) return problems;
  const none = { before: {}, after: {} };
  for (const [type, was] of Object.entries(before.representations)) {
    const now = after.representations[type];
    if (now === undefined) {
      problems.push(`${type}: the representation was removed.`);
      continue;
    }
    problems.push(...schemaBreakingChanges(was, now, "response", none).map((line) => `${type} ${line}`));
    // A protected field stays protected: a receiver relies on null without opt-in.
    for (const field of before.protected[type] ?? []) {
      if (!(after.protected[type] ?? []).includes(field)) problems.push(`${type} ${field}: no longer protected the same way.`);
    }
  }
  problems.push(...schemaBreakingChanges(before.truncation, after.truncation, "response", none).map((line) => `truncation ${line}`));
  return problems;
}

describe("the webhook payload contract", () => {
  it("seals one representation per resource type", () => {
    expect(Object.keys(EVENT_REPRESENTATION_SCHEMAS).sort()).toEqual([...EVENT_RESOURCE_TYPES].sort());
  });

  it("changes only additively within an events API version", async () => {
    expect(committedSnapshot(), "events.representations.snapshot.json is missing: create it with vitest run -u").not.toBeNull();
    expect(await openBreaks(), "Breaking payload changes: keep the old shape, bump EVENTS_API_VERSION, or add these entries with a reason to events.representations.breaks.json.").toEqual([]);
  });

  it("matches the committed snapshot (accept an additive change with -u)", async () => {
    expect(await openBreaks(), "Refusing to seal past a breaking payload change.").toEqual([]);
    await expect(`${JSON.stringify(currentSnapshot(), null, 1)}\n`).toMatchFileSnapshot("../../../../packages/shared/src/events.representations.snapshot.json");
  });

  it("refuses removals, retypes and lost protection", () => {
    const base = currentSnapshot();
    const order = base.representations.order as { properties: Record<string, unknown>; required: string[] };
    const { totalMinor: _total, ...rest } = order.properties;
    const after: RepresentationSnapshot = {
      ...base,
      representations: { ...base.representations, order: { ...order, properties: { ...rest, status: { type: "integer" } } } },
      protected: { ...base.protected, order: base.protected.order!.filter((field) => !field.startsWith("contact.email")) },
    };
    expect(breakingChanges(base, after)).toEqual(expect.arrayContaining([
      "order totalMinor: the field was removed.",
      "order contact.email=email: no longer protected the same way.",
    ]));
    expect(breakingChanges(base, after).some((line) => line.startsWith("order status"))).toBe(true);
  });
});
