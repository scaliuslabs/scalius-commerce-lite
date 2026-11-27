// The webhook representations' breaking-change rule (apps/api/src/events/representations.contract.test.ts
// seals `events.representations.snapshot.json` with it): within an events version no representation
// goes, no field is removed, retyped or made nullable, and a protected field stays protected; a new
// events version is itself a change line. Imports only its siblings (the contract lock's judge loads it
// from a release tag with plain Node).
import { schemaBreakingChanges } from "../schema-compat";

export interface RepresentationSnapshot {
  apiVersion: string;
  representations: Record<string, unknown>;
  truncation: unknown;
  /** Each type's protected fields (`path` joined with "."). */
  protected: Record<string, string[]>;
}

export function representationsBreakingChanges(before: RepresentationSnapshot, after: RepresentationSnapshot): string[] {
  const problems: string[] = [];
  // A new events version carries its own shapes, and the version change itself is acknowledged as `new-version`.
  if (before.apiVersion !== after.apiVersion) return [`apiVersion: ${before.apiVersion} became ${after.apiVersion}: a new contract version.`];
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
