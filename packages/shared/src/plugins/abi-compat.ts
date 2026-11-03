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
//   storefront constant, a member of one of its lists or a key of one of its
//   objects (a list and an object may grow), and no stable port goes back to
//   beta.
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

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One constant's value: a list keeps every member, an object keeps every key and its value (both may grow), anything else stays equal. */
function constantValueBreaks(path: string, was: unknown, now: unknown): string[] {
  if (Array.isArray(was) && Array.isArray(now)) {
    const kept = new Set(now.map((value) => JSON.stringify(value)));
    return was.filter((value) => !kept.has(JSON.stringify(value))).map((value) => `${path}: ${JSON.stringify(value)} was removed.`);
  }
  if (isObject(was) && isObject(now)) {
    return Object.entries(was).flatMap(([key, value]) => key in now
      ? constantValueBreaks(`${path}.${key}`, value, now[key])
      : [`${path}.${key}: the key was removed.`]);
  }
  return JSON.stringify(was) === JSON.stringify(now) ? [] : [`${path}: the constant value changed.`];
}

/** Storefront constants: none disappears, no list loses a member and no object loses a key or changes one. */
function constantBreaks(before: unknown, after: unknown): string[] {
  const problems: string[] = [];
  const now = record(after);
  for (const [name, was] of Object.entries(record(before))) {
    if (!(name in now)) problems.push(`storefront.${name}: the constant was removed.`);
    else problems.push(...constantValueBreaks(`storefront.${name}`, was, now[name]));
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
    if (tier === "stable" && tiers[kind] !== "stable") problems.push(`providerTiers.${kind}: a stable port went back to ${String(tiers[kind])}.`);
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

  // These are the keys emitted by abi.snapshot.test.ts. Legacy adminUi
  // snapshots remain understood; current UI documents and extension hooks
  // must not disappear from the semantic check while their snapshot moves.
  if ("adminUi" in was) problems.push(...schemaBreaks("adminUi", was.adminUi, now.adminUi, "request"));
  if ("extensions" in was) problems.push(...portBreaks("extensions", was.extensions, now.extensions));
  if ("ui" in was) {
    const ui = record(was.ui);
    const nowUi = record(now.ui);
    problems.push(...schemaBreaks("ui.document", ui.document, nowUi.document, "request"));
    const surfaces = record(ui.surfaces);
    const nowSurfaces = record(nowUi.surfaces);
    problems.push(...removedKeys("ui.surfaces", surfaces, nowSurfaces, "surface"));
    for (const [name, surface] of Object.entries(surfaces)) {
      if (!(name in nowSurfaces)) continue;
      const previous = record(surface);
      const next = record(nowSurfaces[name]);
      for (const field of ["nodes", "actions", "targets"]) {
        const kept = new Set(Array.isArray(next[field]) ? next[field] : []);
        for (const value of Array.isArray(previous[field]) ? previous[field] : []) {
          if (!kept.has(value)) problems.push(`ui.surfaces.${name}.${field}: ${JSON.stringify(value)} was removed.`);
        }
      }
      for (const field of ["maxNodes", "maxDepth", "maxBytes"]) {
        if (typeof previous[field] === "number" && (typeof next[field] !== "number" || next[field] < previous[field])) {
          problems.push(`ui.surfaces.${name}.${field}: the limit was removed or tightened.`);
        }
      }
      if (previous.images !== next.images) problems.push(`ui.surfaces.${name}.images: the image policy changed.`);
    }
  }
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
  problems.push(...removedKeys("events.facts", events.facts, nowEvents.facts, "facts schema"));
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
