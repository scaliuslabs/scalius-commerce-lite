// The breaking-change rules of the sealed plugin ABI (`abi.snapshot.test.ts`).
//
// Each rule compares the committed snapshot with the current one, the way an
// installed app sees the change:
//
// - what an app writes and the host reads accepts no less (request rules):
//   the manifest, a function's output, a provider operation's output, the
//   admin UI document;
// - what the host writes and an app reads promises no less (response rules):
//   a function's input, a provider operation's input, an event's facts;
// - nothing an app names disappears: a stable port or its operation, a
//   function point, an event topic or its resource type, a scope, an error
//   code (or its status), a
//   storefront constant or a member of one of its lists, and no stable port
//   goes back to beta.
//
// A break is accepted only by an entry in `abi.breaks.json` naming the exact
// change and the fingerprint of the snapshot it breaks from, so `vitest -u`
// alone never accepts one and an entry never pre-accepts a later break.

import { jsonSchemaBreakingChanges, type SchemaDirection } from "../schema-compat";

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** A sealed `{ input, output }` pair: the input is the host's promise, the output the app's. */
function portBreaks(label: string, before: unknown, after: unknown): string[] {
  const was = record(before);
  const now = record(after);
  return [
    ...jsonSchemaBreakingChanges(was.input, now.input, "response").map((line) => `${label} input ${line}`),
    ...jsonSchemaBreakingChanges(was.output, now.output, "request").map((line) => `${label} output ${line}`),
  ];
}

function removedKeys(label: string, before: unknown, after: unknown, noun: string): string[] {
  const now = record(after);
  return Object.keys(record(before)).filter((key) => !(key in now)).map((key) => `${label}.${key}: the ${noun} was removed.`);
}

function schemaBreaks(label: string, before: unknown, after: unknown, direction: SchemaDirection): string[] {
  return jsonSchemaBreakingChanges(before, after, direction).map((line) => `${label} ${line}`);
}

/** The manifest an app writes: the host must keep accepting every manifest it accepted. */
export function manifestBreakingChanges(before: unknown, after: unknown): string[] {
  return schemaBreaks("manifest", record(before).schema, record(after).schema, "request");
}

/** Storefront constants: none disappears and no list loses a member. */
function constantBreaks(before: unknown, after: unknown): string[] {
  const problems: string[] = [];
  const now = record(after);
  for (const [name, was] of Object.entries(record(before))) {
    if (!(name in now)) {
      problems.push(`storefront.${name}: the constant was removed.`);
      continue;
    }
    if (Array.isArray(was) && Array.isArray(now[name])) {
      const kept = new Set((now[name] as unknown[]).map((value) => JSON.stringify(value)));
      for (const value of was) {
        if (!kept.has(JSON.stringify(value))) problems.push(`storefront.${name}: ${JSON.stringify(value)} was removed.`);
      }
    }
  }
  return problems;
}

/** Functions, stable ports, admin UI, scopes, events and storefront constants. */
export function protocolBreakingChanges(before: unknown, after: unknown): string[] {
  const was = record(before);
  const now = record(after);
  const problems: string[] = [];

  const nowFunctions = record(now.functions);
  problems.push(...removedKeys("functions", was.functions, now.functions, "function point"));
  for (const [name, value] of Object.entries(record(was.functions))) {
    if (name in nowFunctions) problems.push(...portBreaks(`functions.${name}`, value, nowFunctions[name]));
  }

  const tiers = record(now.providerTiers);
  for (const [kind, tier] of Object.entries(record(was.providerTiers))) {
    if (tier === "stable" && kind in tiers && tiers[kind] !== "stable") problems.push(`providerTiers.${kind}: a stable port went back to ${String(tiers[kind])}.`);
  }
  const nowProviders = record(now.providers);
  problems.push(...removedKeys("providers", was.providers, now.providers, "stable port"));
  for (const [kind, operations] of Object.entries(record(was.providers))) {
    if (!(kind in nowProviders)) continue;
    const nowOperations = record(nowProviders[kind]);
    problems.push(...removedKeys(`providers.${kind}`, operations, nowOperations, "operation"));
    for (const [operation, value] of Object.entries(record(operations))) {
      if (operation in nowOperations) problems.push(...portBreaks(`providers.${kind}.${operation}`, value, nowOperations[operation]));
    }
  }

  problems.push(...schemaBreaks("adminUi", was.adminUi, now.adminUi, "request"));
  problems.push(...removedKeys("scopes", was.scopes, now.scopes, "scope"));

  const nowErrors = record(now.errors);
  for (const [code, entry] of Object.entries(record(was.errors))) {
    if (!(code in nowErrors)) problems.push(`errors.${code}: the error code was removed.`);
    else if (record(entry).status !== record(nowErrors[code]).status) {
      problems.push(`errors.${code}: the status changed from ${String(record(entry).status)} to ${String(record(nowErrors[code]).status)}.`);
    }
  }

  const events = record(was.events);
  const nowEvents = record(now.events);
  const nowResources = record(nowEvents.resources);
  for (const [topic, resource] of Object.entries(record(events.resources))) {
    if (!(topic in nowResources)) problems.push(`events.${topic}: the topic was removed.`);
    else if (nowResources[topic] !== resource) problems.push(`events.${topic}: the resource type changed from ${String(resource)} to ${String(nowResources[topic])}.`);
  }
  const nowFacts = record(nowEvents.facts);
  for (const [topic, value] of Object.entries(record(events.facts))) {
    if (topic in nowFacts) problems.push(...schemaBreaks(`events.${topic} facts`, value, nowFacts[topic], "response"));
  }

  problems.push(...constantBreaks(was.storefront, now.storefront));
  return problems;
}

/** One accepted break: the exact change line, from the snapshot whose fingerprint is `from`. */
export interface AbiBreakAcknowledgement {
  snapshot: string;
  from: string;
  change: string;
  reason: string;
}

/** A short, stable fingerprint of a committed snapshot's text. */
export async function snapshotFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The breaks no acknowledgement accepts, each as a ready-to-review entry. */
export function unacknowledgedBreaks(
  snapshot: string,
  from: string,
  breaks: readonly string[],
  acknowledgements: readonly AbiBreakAcknowledgement[],
): AbiBreakAcknowledgement[] {
  const accepted = new Set(acknowledgements
    .filter((entry) => entry.snapshot === snapshot && entry.from === from && entry.reason.trim().length > 0)
    .map((entry) => entry.change));
  return breaks.filter((change) => !accepted.has(change)).map((change) => ({ snapshot, from, change, reason: "" }));
}
